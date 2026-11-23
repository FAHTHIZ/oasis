import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, buildReceipt, signReceipt, createReceipt, verifyReceipt, receiptKey, replayPlan, chainEvents, formatVerification, RECEIPT_FORMAT } from '../src/receipts.mjs';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { sanitizeEvidenceLedger } from '../src/sessions.mjs';
import { receiptCommand } from '../src/receipt-cli.mjs';

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(3)"';

async function fixture(t, { checkCommand = PASS, passed = true, reply = 'Fixed the bug in app.js. All tests pass.' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-key-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  await writeFile(path.join(root, 'app.js'), 'export const add = (a, b) => a + b;\n');
  const ledger = createEvidenceLedger();
  recordEvidence(ledger, { kind: 'edit', tool: 'write_file', path: 'app.js', digest: 'aaaa' });
  recordEvidence(ledger, { kind: 'check', tool: 'run_shell', command: checkCommand, checkKind: 'test', exitCode: passed ? 0 : 3, finished: true, masked: false, passed, digest: 'bbbb' });
  const session = {
    root,
    sessionId: 's1',
    config: { model: 'test-model' },
    evidenceLedger: ledger,
    messages: [{ role: 'user', content: 'Fix the bug in app.js' }, { role: 'assistant', content: reply }]
  };
  return { root, env, session };
}

test('canonical JSON sorts keys at every depth and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
});

test('a receipt of real work verifies: signature, chain, claims and files', async (t) => {
  const { root, env, session } = await fixture(t);
  const receipt = await createReceipt(session, { env });
  assert.equal(receipt.format, RECEIPT_FORMAT);
  assert.equal(receipt.evidence.count, 2);
  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.files[0].path, 'app.js');
  assert.equal(receipt.run.model, 'test-model');
  assert.ok(receipt.claims.items.some((claim) => claim.status === 'observed'), 'the passing-test claim is observed');
  assert.deepEqual(receipt.replay.map((step) => step.command), [PASS]);
  assert.match(receipt.signature.keyId, /^ed25519:[0-9a-f]{32}$/);
  const verdict = await verifyReceipt(receipt, { root });
  assert.equal(verdict.status, 'verified', formatVerification(receipt, verdict));
  assert.ok(verdict.ok);
});

test('editing anything in a signed receipt is detected', async (t) => {
  const { root, env, session } = await fixture(t);
  const receipt = await createReceipt(session, { env });
  const forged = structuredClone(receipt);
  forged.run.reply = 'All 500 tests pass and the deploy succeeded.';
  assert.equal((await verifyReceipt(forged, { root })).status, 'tampered');
  const flipped = structuredClone(receipt);
  flipped.evidence.events[1].exitCode = 0;
  flipped.evidence.events[1].passed = true;
  flipped.evidence.events[1].command = 'npm test';
  assert.equal((await verifyReceipt(flipped, { root })).status, 'tampered');
});

test('a re-signed receipt with a broken chain or a foreign key is still caught', async (t) => {
  const { root, env, session } = await fixture(t, { checkCommand: FAIL, passed: false, reply: 'Fixed the bug.' });
  const body = await buildReceipt(session);
  // Rewrite the failing check as a pass and sign it with a valid key: the chain no longer links.
  body.evidence.events[1] = { ...body.evidence.events[1], exitCode: 0, passed: true };
  const resigned = await signReceipt(body, { env });
  const verdict = await verifyReceipt(resigned, { root });
  assert.equal(verdict.status, 'tampered');
  assert.ok(verdict.checks.some((item) => item.name === 'evidence chain' && !item.ok));
  // A correctly chained receipt signed by an untrusted key fails when the signer is pinned.
  const other = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-other-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const otherKey = await receiptKey({ directory: other });
  const mine = await receiptKey({ env });
  const genuine = await signReceipt(await buildReceipt(session), { key: otherKey });
  assert.equal((await verifyReceipt(genuine, { root })).status, 'verified');
  assert.equal((await verifyReceipt(genuine, { root, trustedKeys: [mine.keyId] })).status, 'tampered');
  assert.equal((await verifyReceipt(genuine, { root, trustedKeys: [otherKey.keyId] })).status, 'verified');
});

test('the signing key is created once and reused', async (t) => {
  const { env } = await fixture(t);
  const first = await receiptKey({ env });
  const second = await receiptKey({ env });
  assert.equal(first.keyId, second.keyId);
  const mode = (await import('node:fs')).statSync(first.file).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('a workspace that changed after the receipt is reported as drifted', async (t) => {
  const { root, env, session } = await fixture(t);
  const receipt = await createReceipt(session, { env });
  await writeFile(path.join(root, 'app.js'), 'export const add = (a, b) => a - b;\n');
  const verdict = await verifyReceipt(receipt, { root });
  assert.equal(verdict.status, 'drifted');
  assert.match(verdict.checks.find((item) => item.name === 'files').detail, /app\.js/);
  // Without a workspace, only the receipt itself is checked.
  assert.equal((await verifyReceipt(receipt)).status, 'verified');
});

test('a reply that claims a pass the evidence contradicts is unsupported', async (t) => {
  const { root, env, session } = await fixture(t, { checkCommand: FAIL, passed: false, reply: 'All tests pass.' });
  const receipt = await createReceipt(session, { env });
  assert.ok(receipt.claims.items.some((claim) => claim.status === 'contradicted'));
  const verdict = await verifyReceipt(receipt, { root });
  assert.equal(verdict.status, 'unsupported');
  assert.ok(!verdict.ok);
});

test('replay reruns the recorded checks and compares the outcome', async (t) => {
  const { root, env, session } = await fixture(t);
  const receipt = await createReceipt(session, { env });
  const seen = [];
  const verdict = await verifyReceipt(receipt, { root, replay: true, env, onReplay: (step) => seen.push(step.command) });
  assert.equal(verdict.status, 'reproduced', formatVerification(receipt, verdict));
  assert.deepEqual(seen, [PASS]);
  // The same receipt replayed where the check now fails.
  const failing = structuredClone(receipt.replay);
  failing[0].command = FAIL;
  const body = await buildReceipt(session);
  const forgedReplay = await signReceipt({ ...body, replay: failing }, { env });
  assert.equal((await verifyReceipt(forgedReplay, { root, replay: true, env })).status, 'failed_replay');
});

test('replay refuses to run commands from an unsigned or altered receipt', async (t) => {
  const { root, env, session } = await fixture(t);
  const receipt = await createReceipt(session, { env });
  const marker = path.join(root, 'ran.txt');
  receipt.replay = [{ command: 'node -e "require(\'fs\').writeFileSync(' + JSON.stringify(marker) + ', \'x\')"', expect: 'pass' }];
  const verdict = await verifyReceipt(receipt, { root, replay: true });
  assert.equal(verdict.status, 'tampered');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('replay refuses commands from a validly self-signed receipt whose signer is not trusted', async (t) => {
  const { root, env, session } = await fixture(t);
  const marker = path.join(root, 'pwned.txt');
  const body = await buildReceipt(session);
  body.replay = [{ command: 'node -e "require(\'fs\').writeFileSync(\'pwned.txt\', \'x\')"', expect: 'pass' }];
  // An attacker signs with their own key: the signature is valid, the key is theirs.
  const attacker = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-attacker-'));
  t.after(() => rm(attacker, { recursive: true, force: true }));
  const forged = await signReceipt(body, { env: { ...process.env, OASIS_CONFIG_DIR: attacker } });
  const verdict = await verifyReceipt(forged, { root, replay: true, env });
  assert.equal(verdict.status, 'untrusted_signer', formatVerification(forged, verdict));
  assert.ok(!verdict.ok);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  // Without replay it is still reported, but never as plainly genuine.
  const plain = await verifyReceipt(forged, { root, env });
  assert.match(plain.summary, /not trusted here/);
  assert.ok(plain.checks.some((item) => item.name === 'signer' && item.level === 'warning'));
  // Trusting the key explicitly runs it.
  const trusted = await verifyReceipt(forged, { root, replay: true, env, trustedKeys: [forged.signature.keyId] });
  assert.equal(trusted.status, 'reproduced', formatVerification(forged, trusted));
  assert.equal(await readFile(marker, 'utf8'), 'x');
});

test('receipt verify --replay on the CLI refuses an untrusted signer and verifying creates no key', async (t) => {
  const { root, env, session } = await fixture(t);
  const marker = path.join(root, 'pwned.txt');
  const body = await buildReceipt(session);
  body.replay = [{ command: 'node -e "require(\'fs\').writeFileSync(\'pwned.txt\', \'x\')"', expect: 'pass' }];
  const attacker = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-attacker-'));
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-fresh-'));
  t.after(() => Promise.all([rm(attacker, { recursive: true, force: true }), rm(fresh, { recursive: true, force: true })]));
  const forged = await signReceipt(body, { env: { ...process.env, OASIS_CONFIG_DIR: attacker } });
  const file = path.join(root, 'forged.json');
  await writeFile(file, JSON.stringify(forged));
  let out = '';
  const code = await receiptCommand(['verify', file, '--replay'], root, { write: (text) => { out += text; }, env: { ...process.env, OASIS_CONFIG_DIR: fresh } });
  assert.equal(code, 1);
  assert.match(out, /UNTRUSTED_SIGNER/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(fresh, 'receipts', 'signing-key.pem')), { code: 'ENOENT' });
  void env;
});

test('replay plan keeps the latest run of each check after the last edit', () => {
  const events = [
    { seq: 1, kind: 'check', command: 'npm test', finished: true, passed: false, exitCode: 1 },
    { seq: 2, kind: 'edit', path: 'a.js' },
    { seq: 3, kind: 'check', command: 'npm test', finished: true, passed: false, exitCode: 1 },
    { seq: 4, kind: 'check', command: 'npm run lint', finished: true, passed: true, exitCode: 0 },
    { seq: 5, kind: 'check', command: 'npm test', finished: true, passed: true, exitCode: 0 },
    { seq: 6, kind: 'check', command: 'npm test | tail', finished: true, masked: true, passed: null }
  ];
  assert.deepEqual(replayPlan(events).map((step) => [step.command, step.expect]), [['npm run lint', 'pass'], ['npm test', 'pass']]);
});

test('chain links depend on order', () => {
  const a = chainEvents([{ seq: 1, kind: 'edit' }, { seq: 2, kind: 'check' }]);
  const b = chainEvents([{ seq: 2, kind: 'check' }, { seq: 1, kind: 'edit' }]);
  assert.notEqual(a[1].link, b[1].link);
});

test('secrets in the request and reply are redacted in the receipt', async (t) => {
  const { env, session } = await fixture(t, { reply: 'Used key sk-ant-api03-' + 'A'.repeat(90) + ' to call the API.' });
  const receipt = await createReceipt(session, { env });
  assert.ok(!receipt.run.reply.includes('A'.repeat(90)));
});

test('the evidence ledger survives a session save and restore', () => {
  const ledger = createEvidenceLedger();
  recordEvidence(ledger, { kind: 'edit', tool: 'write_file', path: 'a.js', digest: 'd1' });
  recordEvidence(ledger, { kind: 'check', tool: 'run_shell', command: 'npm test', exitCode: 0, finished: true, passed: true, numbers: ['1', '2'], digest: 'd2' });
  const restored = sanitizeEvidenceLedger(JSON.parse(JSON.stringify(ledger)));
  assert.equal(restored.events.length, 2);
  assert.equal(restored.seq, 2);
  assert.equal(restored.epoch, 1);
  assert.equal(restored.events[1].passed, true);
  assert.deepEqual(restored.events[1].numbers, ['1', '2']);
  assert.equal(sanitizeEvidenceLedger({ events: [{ kind: 'x' }, null, 'bad'] }).events.length, 0);
  assert.equal(sanitizeEvidenceLedger(null), null);
});

test('oasis receipt verify exits 0 for a good receipt and 1 for a forged one', async (t) => {
  const { root, env, session } = await fixture(t);
  const receipt = await createReceipt(session, { env });
  const good = path.join(root, 'good.json');
  const bad = path.join(root, 'bad.json');
  await writeFile(good, JSON.stringify(receipt));
  await writeFile(bad, JSON.stringify({ ...receipt, run: { ...receipt.run, reply: 'forged' } }));
  let out = '';
  const write = (text) => { out += text; };
  assert.equal(await receiptCommand(['verify', good], root, { write, env }), 0);
  assert.match(out, /VERIFIED/);
  out = '';
  assert.equal(await receiptCommand(['verify', bad, '--json'], root, { write, env }), 1);
  assert.equal(JSON.parse(out).status, 'tampered');
  out = '';
  assert.equal(await receiptCommand(['show', good], root, { write, env }), 0);
  assert.match(out, /test-model/);
});

test('oasis receipt key --new prints a usable PEM that is not saved', async (t) => {
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-receipt-new-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const { receiptKeyFromPem } = await import('../src/receipts.mjs');
  let out = '';
  assert.equal(await receiptCommand(['key', '--new'], config, { write: (text) => { out += text; }, env: { ...process.env, OASIS_CONFIG_DIR: config } }), 0);
  const id = out.match(/# Key id: (ed25519:[0-9a-f]{32})/)[1];
  assert.equal(receiptKeyFromPem(out).keyId, id);
  assert.equal(receiptKeyFromPem(out.replace(/\n/g, '\\n')).keyId, id, 'a secret stored with escaped newlines still loads');
  await assert.rejects(readFile(path.join(config, 'receipts', 'signing-key.pem')), { code: 'ENOENT' });
  const { generateKeyPairSync } = await import('node:crypto');
  assert.throws(() => receiptKeyFromPem(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })), /Ed25519/);
});

test('oasis receipt create writes a verifiable receipt for a saved session, after the fact', async (t) => {
  const { root, env, session } = await fixture(t);
  const { saveSession } = await import('../src/sessions.mjs');
  const saved = await saveSession({ ...session, sessionId: undefined, messages: [{ role: 'system', content: 'You are OASIS.' }, ...session.messages] }, { env });
  let out = '';
  const write = (text) => { out += text; };
  assert.equal(await receiptCommand(['create', '--session', saved.id, '-o', 'after.json', '--json'], root, { write, env }), 0);
  const info = JSON.parse(out);
  assert.equal(info.session, saved.id);
  assert.equal(info.events, 2, 'the saved evidence ledger is in the receipt');
  assert.equal(info.file, path.join(root, 'after.json'));
  const receipt = JSON.parse(await readFile(info.file, 'utf8'));
  assert.equal(receipt.run.sessionId, saved.id);
  assert.match(receipt.run.request, /Fix the bug/);
  assert.equal((await verifyReceipt(receipt, { root })).status, 'verified');
  out = '';
  assert.equal(await receiptCommand(['create', '--last'], root, { write, env }), 0);
  assert.match(out, new RegExp('Receipt for session ' + saved.id + ' written to .*oasis-receipt-' + saved.id.slice(0, 8) + '\\.json'));
  out = '';
  assert.equal(await receiptCommand(['show', info.file], root, { write, env }), 0);
  assert.match(out, /Claims: {4}\d+ \w+/);
});
