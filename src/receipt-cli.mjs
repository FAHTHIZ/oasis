// `oasis receipt`: verify, show and sign work receipts (src/receipts.mjs).
//
//   oasis receipt verify FILE [--replay] [--trust KEY_ID]... [--no-workspace] [--json]
//   oasis receipt show FILE [--json]
//   oasis receipt create [--session ID|--last] [-o FILE]   receipt for a saved session
//   oasis receipt key            print this machine's receipt key id and public key
//   oasis receipt key --new      print a new private key (PEM) for a CI secret, and its key id
//
// verify exits 0 when the receipt is verified (or reproduced with --replay),
// 1 otherwise, so it can gate CI.

import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { readReceipt, verifyReceipt, formatVerification, receiptKey, receiptKeyFromPem } from './receipts.mjs';

const USAGE = [
  'Usage:',
  '  oasis receipt verify FILE [--replay] [--trust KEY_ID] [--no-workspace] [--json]',
  '  oasis receipt show FILE [--json]',
  '  oasis receipt create [--session ID | --last] [-o FILE]',
  '  oasis receipt key [--new]',
  '',
  'Create a receipt with: oasis -p "task" --receipt receipt.json',
  '--replay reruns the checks recorded in the receipt in this workspace. Only replay receipts you trust,',
  'or run it in a sandbox or CI container: the commands come from the receipt.'
].join('\n');

export async function receiptCommand(args, workspace, { write = (text) => process.stdout.write(text), env = process.env } = {}) {
  const [sub, ...rest] = args;
  const json = rest.includes('--json');
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { write(USAGE + '\n'); return 0; }
  if (sub === 'key' && rest.includes('--new')) {
    // For CI: store the PEM as a secret (gh secret set OASIS_RECEIPT_KEY) and
    // pass it to the action's receipt_signing_key; reviewers pin the key id.
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyId = receiptKeyFromPem(pem).keyId;
    if (json) write(JSON.stringify({ keyId, privateKey: pem }) + '\n');
    else write(pem + '# Key id: ' + keyId + '\n# Save the lines above as a secret, e.g. oasis receipt key --new | gh secret set OASIS_RECEIPT_KEY\n');
    return 0;
  }
  if (sub === 'key') {
    const key = await receiptKey({ env });
    if (json) write(JSON.stringify({ keyId: key.keyId, publicKey: key.publicKey }) + '\n');
    else write('Receipt key: ' + key.keyId + '\nPublic key (SPKI, base64): ' + key.publicKey + '\nPrivate key: ' + key.file + '\n');
    return 0;
  }
  if (sub === 'create') return createFromSession(rest, workspace, { write, env, json });
  const file = rest.find((word) => !word.startsWith('-') && !isFlagValue(rest, word));
  if (!file) throw new Error('Name the receipt file.\n' + USAGE);
  const receipt = await readReceipt(file);
  if (sub === 'show') {
    if (json) { write(JSON.stringify(receipt, null, 2) + '\n'); return 0; }
    const run = receipt.run || {};
    const counts = receipt.claims && receipt.claims.counts || {};
    write([
      'Receipt ' + receipt.issuedAt + ' by ' + (receipt.signature && receipt.signature.keyId || 'unsigned'),
      'Workspace: ' + (receipt.subject && receipt.subject.workspace) + (receipt.subject && receipt.subject.git ? ' @ ' + receipt.subject.git.head.slice(0, 12) + (receipt.subject.git.dirty ? ' (+ uncommitted changes)' : '') : ''),
      'Model:     ' + (run.model || 'unknown') + (run.verdict ? ' · verdict ' + run.verdict : ''),
      'Asked:     ' + String(run.request || '').split('\n')[0].slice(0, 160),
      'Evidence:  ' + (receipt.evidence && receipt.evidence.count || 0) + ' events · files ' + (receipt.files || []).length + ' · replayable checks ' + (receipt.replay || []).length,
      'Claims:    ' + (Object.entries(counts).filter(([, n]) => n).map(([k, n]) => n + ' ' + k).join(', ') || 'none'),
      ''
    ].join('\n'));
    return 0;
  }
  if (sub === 'verify') {
    const trustedKeys = rest.flatMap((word, index) => (word === '--trust' && rest[index + 1] ? [rest[index + 1]] : word.startsWith('--trust=') ? [word.slice(8)] : []));
    const replay = rest.includes('--replay');
    const root = rest.includes('--no-workspace') ? '' : workspace;
    const verdict = await verifyReceipt(receipt, {
      root, replay, trustedKeys, env,
      onReplay: json ? null : (step) => write('[replay] ' + step.command + '\n')
    });
    write(json ? JSON.stringify(verdict) + '\n' : formatVerification(receipt, verdict) + '\n');
    return verdict.ok ? 0 : 1;
  }
  throw new Error('Unknown receipt command "' + sub + '".\n' + USAGE);
}

const VALUE_FLAGS = new Set(['--trust', '--session', '-o', '--output']);

function isFlagValue(args, word) {
  const index = args.indexOf(word);
  return index > 0 && VALUE_FLAGS.has(args[index - 1]);
}

function flagValue(args, ...names) {
  for (let index = 0; index < args.length; index += 1) {
    for (const name of names) {
      if (args[index] === name && args[index + 1]) return args[index + 1];
      if (args[index].startsWith(name + '=')) return args[index].slice(name.length + 1);
    }
  }
  return '';
}

// A receipt for a saved session, written after the fact: sessions keep their
// evidence ledger, so the receipt covers every turn that was saved.
async function createFromSession(args, workspace, { write, env, json }) {
  const { loadSession, listSessions } = await import('./sessions.mjs');
  const { createReceipt, writeReceipt } = await import('./receipts.mjs');
  let id = flagValue(args, '--session') || args.find((word) => !word.startsWith('-') && !isFlagValue(args, word)) || '';
  if (!id || args.includes('--last')) {
    const [latest] = await listSessions(workspace, { env });
    if (!latest) throw new Error('There are no saved sessions in this workspace.');
    id = latest.id;
  }
  const saved = await loadSession(workspace, id, { env });
  const session = { root: workspace, sessionId: saved.id, config: { model: saved.provider && saved.provider.model || null }, messages: saved.messages, evidenceLedger: saved.evidenceLedger || { events: [] }, task: saved.task || null };
  const receipt = await createReceipt(session, { env, root: workspace });
  const output = flagValue(args, '-o', '--output') || 'oasis-receipt-' + saved.id.slice(0, 8) + '.json';
  const file = await writeReceipt(path.resolve(workspace, output), receipt);
  const target = typeof file === 'string' ? file : output;
  if (json) write(JSON.stringify({ file: target, session: saved.id, events: receipt.evidence.count, keyId: receipt.signature.keyId }) + '\n');
  else write('Receipt for session ' + saved.id + ' written to ' + target + ': ' + receipt.evidence.count + ' evidence events, ' + receipt.files.length + ' file(s). Signed by ' + receipt.signature.keyId + '.\n' + (receipt.evidence.count ? '' : 'This session has no saved evidence (it was saved before sessions kept it), so the receipt only records the conversation.\n'));
  return 0;
}
