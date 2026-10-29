import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { runBuiltinCommand, BUILTIN_COMMANDS, SKILL_COMMANDS, reviewPrompt } from '../src/slash.mjs';
import { createCompleter } from '../src/completion.mjs';
import { imageInputCapability } from '../src/images.mjs';
import { executeTool } from '../src/tools.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-commands-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-home-'));
  const configDir = path.join(home, '.config', 'oasis');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: configDir };
  await mkdir(root, { recursive: true });
  const session = {
    root,
    config: { protocol: 'openai-compatible', model: 'gpt-5' },
    messages: [{ role: 'system', content: 'system' }],
    checkpoints: { turns: [], bytes: 0 }
  };
  const state = { root, env, session, sessionOptions: {}, autoApprove: false };
  return { root, home, configDir, env, session, state };
}

test('core skill command registry stays small, explicit, and discoverable', () => {
  assert.deepEqual(Object.keys(SKILL_COMMANDS), ['init', 'plan', 'fix', 'diagnose', 'review', 'rollback']);
  for (const name of Object.keys(SKILL_COMMANDS)) {
    assert.ok(BUILTIN_COMMANDS[name], 'built-in help entry for ' + name);
    assert.ok(SKILL_COMMANDS[name].skill, 'portable skill mapping for ' + name);
    assert.ok(SKILL_COMMANDS[name].mode, 'permission mode for ' + name);
    assert.ok(SKILL_COMMANDS[name].summary, 'preview summary for ' + name);
  }
});

test('every core command maps to a portable skill with the required section structure', async () => {
  const required = ['# Purpose', '## Inputs', '## Workflow', '## Required provider capabilities', '## Permissions', '## Success criteria'];
  for (const skill of new Set(Object.values(SKILL_COMMANDS).map((item) => item.skill))) {
    const content = await readFile(new URL('../skills/' + skill + '/SKILL.md', import.meta.url), 'utf8');
    assert.ok(content.startsWith('---\nname: ' + skill + '\n'), skill + ' front matter');
    for (const heading of required) assert.ok(content.includes(heading), skill + ' is missing ' + heading);
  }
});

test('terminal slash completion puts the six core workflows first', async () => {
  const { root } = await fixture();
  const complete = createCompleter({ root, commands: async () => [
    { name: 'help', description: 'Help' },
    { name: 'rollback', description: 'Preview restore' },
    { name: 'plan', description: 'Plan' },
    { name: 'fix', description: 'Fix' },
    { name: 'review', description: 'Review' },
    { name: 'diagnose', description: 'Diagnose' },
    { name: 'init', description: 'Init' },
    { name: 'zebra', description: 'Another command' }
  ] });
  const result = await complete('/', 1);
  assert.deepEqual(result.candidates.slice(0, 6).map((item) => item.value), [
    '/init', '/plan', '/fix', '/diagnose', '/review', '/rollback'
  ]);
});

test('review prompt loads the portable code-review skill', () => {
  const prompt = reviewPrompt('review', '');
  assert.ok(prompt.includes('load_skill({ name: "code-review" })'));
  assert.match(prompt, /accessibility/i);
  assert.match(prompt, /read-only/i);
});

test('missing task inputs do not start /plan, /fix, or /diagnose', async () => {
  const { state } = await fixture();
  for (const name of ['plan', 'fix', 'diagnose']) {
    const result = await runBuiltinCommand(name, '', state);
    assert.match(result.output, /Usage:/, name + ' reports missing input');
    assert.equal(result.prompt, undefined, name + ' does not start the agent');
  }
});

test('routing prepares explicit skill workflows and keeps /plan read-only', async () => {
  const { state } = await fixture();
  const init = await runBuiltinCommand('init', '', state);
  assert.match(init.output, /Preview:/);
  assert.match(init.prompt, /load_skill\(\{ name: "init" \}\)/);
  assert.match(init.prompt, /OASIS\.md/);

  const plan = await runBuiltinCommand('plan', 'Add a small settings panel', state);
  assert.equal(plan.planOnly, true);
  assert.match(plan.prompt, /load_skill\(\{ name: "plan" \}\)/);
  assert.match(plan.prompt, /Do not edit files/);

  const fix = await runBuiltinCommand('fix', 'The filter crashes on an empty list', state);
  assert.match(fix.prompt, /load_skill\(\{ name: "debugging" \}\)/);
  assert.match(fix.output, /snapshots/);

  const diagnose = await runBuiltinCommand('diagnose', 'TypeError: value.map is not a function', state);
  assert.match(diagnose.prompt, /load_skill\(\{ name: "diagnose" \}\)/);
  assert.match(diagnose.output, /read-only/);
});

test('image capability preflight distinguishes supported, unsupported, and unknown models', () => {
  assert.equal(imageInputCapability({ model: 'gpt-5' }, {}).status, 'supported');
  assert.equal(imageInputCapability({ model: 'custom-provider/model-x' }, {}).status, 'unknown');
  assert.equal(imageInputCapability({ model: 'gpt-5', vision: false }, {}).status, 'unsupported');
  assert.equal(imageInputCapability({ model: 'custom/model' }, { OASIS_MODEL_VISION: 'off' }).status, 'unsupported');
  assert.equal(imageInputCapability({ model: 'gpt-3.5-turbo' }, {}).status, 'unsupported');
});

test('/diagnose explicitly discloses unknown screenshot capability', async () => {
  const { state } = await fixture();
  state.session.config = { protocol: 'openai-compatible', model: 'custom-provider/model-x' };
  const result = await runBuiltinCommand('diagnose', 'Please inspect screenshot /tmp/failure.webp', state);
  assert.match(result.output, /Image input status: unknown/i);
  assert.match(result.prompt, /never claim to have viewed a screenshot/i);
  assert.match(result.prompt, /image support is unsupported or unknown/i);
});

test('file deletion and command execution respect explicit approval denial', async () => {
  const { root, env } = await fixture();
  const protectedFile = path.join(root, 'protected.txt');
  const markerFile = path.join(root, 'command-ran.txt');
  await writeFile(protectedFile, 'keep me', 'utf8');

  let deleteApprovalPrompt = '';
  const deletion = await executeTool('delete_file', { path: 'protected.txt' }, {
    root, env,
    approval: async (prompt) => { deleteApprovalPrompt = prompt; return false; }
  });
  assert.equal(deletion.approved, false);
  assert.match(deleteApprovalPrompt, /Delete the workspace file/);
  assert.equal(await readFile(protectedFile, 'utf8'), 'keep me');

  let commandApprovalPrompt = '';
  const command = await executeTool('run_command', {
    command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(markerFile) + ', "ran")'],
    timeoutSeconds: 5
  }, {
    root, env, autoApprove: false,
    approval: async (prompt) => { commandApprovalPrompt = prompt; return false; }
  });
  assert.equal(command.approved, false);
  assert.ok(commandApprovalPrompt, 'an explicit approval prompt was issued');
  await assert.rejects(() => stat(markerFile), { code: 'ENOENT' });
});

test('/rollback preview makes no changes; confirmation backs up current files before restoring', async () => {
  const { root, configDir, env, session, state } = await fixture();
  const existing = path.join(root, 'src.js');
  const created = path.join(root, 'generated.txt');
  await writeFile(existing, 'new contents\n', 'utf8');
  await writeFile(created, 'created in the checkpoint\n', 'utf8');

  const userMessage = { role: 'user', content: 'Apply the earlier change' };
  session.messages.push(userMessage, { role: 'assistant', content: 'I changed two files.' });
  session.checkpoints = {
    bytes: Buffer.byteLength('old contents\n'),
    turns: [{
      userMessage,
      prompt: 'Apply the earlier change',
      createdAt: '2026-10-29T12:00:00.000Z',
      files: new Map([
        ['src.js', { existed: true, content: Buffer.from('old contents\n'), mode: 0o644 }],
        ['generated.txt', { existed: false, content: null }]
      ])
    }]
  };

  const preview = await runBuiltinCommand('rollback', '', state);
  assert.match(preview.output, /ROLLBACK PREVIEW/);
  assert.match(preview.output, /src\.js/);
  assert.match(preview.output, /generated\.txt/);
  assert.equal(await readFile(existing, 'utf8'), 'new contents\n');
  assert.equal(await readFile(created, 'utf8'), 'created in the checkpoint\n');
  assert.equal(session.messages.length, 3, 'preview does not alter conversation');
  assert.equal(session.checkpoints.turns.length, 1);

  const result = await runBuiltinCommand('rollback', 'confirm', state);
  assert.match(result.output, /Rollback completed/);
  assert.equal(await readFile(existing, 'utf8'), 'old contents\n');
  await assert.rejects(() => stat(created), { code: 'ENOENT' });
  assert.equal(session.messages.length, 3, 'file-only rollback leaves conversation untouched');
  assert.equal(session.checkpoints.turns.length, 0, 'successfully consumed checkpoint cannot be accidentally replayed');
  assert.equal(result.rollback.recovery.length, 2, 'current versions of both files are recoverable');

  const backupRoot = path.join(configDir, 'backups');
  const identityDirs = await readdir(backupRoot);
  assert.equal(identityDirs.length, 1);
  const backupIds = await readdir(path.join(backupRoot, identityDirs[0]));
  assert.equal(backupIds.length, 2);
  for (const backupId of backupIds) {
    const manifest = JSON.parse(await readFile(path.join(backupRoot, identityDirs[0], backupId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.reason, 'before-skill-rollback');
    const backupContent = await readFile(path.join(backupRoot, identityDirs[0], backupId, manifest.relativePath), 'utf8');
    assert.ok(backupContent === 'new contents\n' || backupContent === 'created in the checkpoint\n');
  }
});

test('/rollback confirmation is tied to the exact latest preview', async () => {
  const { root, session, state } = await fixture();
  await writeFile(path.join(root, 'a.txt'), 'current');
  const userMessage = { role: 'user', content: 'change a' };
  const first = {
    userMessage,
    prompt: 'change a',
    createdAt: '2026-10-29T12:00:00.000Z',
    files: new Map([['a.txt', { existed: true, content: Buffer.from('before'), mode: 0o644 }]])
  };
  session.messages.push(userMessage);
  session.checkpoints = { turns: [first], bytes: 6 };
  await runBuiltinCommand('rollback', '', state);
  session.checkpoints.turns.push({
    userMessage: { role: 'user', content: 'newer change' },
    prompt: 'newer change',
    createdAt: '2026-10-29T12:01:00.000Z',
    files: new Map()
  });
  const confirm = await runBuiltinCommand('rollback', 'confirm', state);
  assert.match(confirm.output, /checkpoint changed/i);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'current');
});
