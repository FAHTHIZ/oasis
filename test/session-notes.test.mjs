import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { saveSessionNotes } from '../src/session-notes.mjs';
import { compactHistoryIfNeeded, createSession, closeSession } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function tempDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-session-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('session notes redact credentials and preserve user-authored text around the generated section', async (t) => {
  const root = await tempDir(t);
  const directory = path.join(root, '.oasis');
  await mkdir(directory);
  const file = path.join(directory, 'session-notes.md');
  await writeFile(file, '# My workspace notes\n\nKeep this reminder exactly as written.\n');

  await saveSessionNotes(root, 'Project Phoenix began in src/app.mjs. Provider key sk-ant-abcdefghijklmnop123456; api_key=private-value.', {
    now: '2026-10-31T00:00:00.000Z',
    savedTokens: 4200
  });

  let notes = await readFile(file, 'utf8');
  assert.match(notes, /# My workspace notes/);
  assert.match(notes, /Keep this reminder exactly as written\./);
  assert.match(notes, /Project Phoenix began in src\/app\.mjs/);
  assert.match(notes, /Saved: 2026-10-31T00:00:00\.000Z/);
  assert.match(notes, /Approximate context saved: 4,200 tokens/);
  assert.match(notes, /\[redacted secret\]/);
  assert.match(notes, /api_key=\[redacted\]/);
  assert.doesNotMatch(notes, /sk-ant-abcdefghijklmnop123456|private-value/);

  notes += '\nMy own footer must survive updates.\n';
  await writeFile(file, notes);
  await saveSessionNotes(root, 'The next compacted summary still mentions Project Phoenix.', { savedTokens: 900 });
  notes = await readFile(file, 'utf8');
  assert.match(notes, /Keep this reminder exactly as written\./);
  assert.match(notes, /My own footer must survive updates\./);
  assert.match(notes, /The next compacted summary still mentions Project Phoenix\./);
  assert.doesNotMatch(notes, /Project Phoenix began in src\/app\.mjs/);
  assert.equal(notes.split('<!-- OASIS GENERATED SESSION NOTES START -->').length - 1, 1);
  assert.equal(notes.split('<!-- OASIS GENERATED SESSION NOTES END -->').length - 1, 1);
});

test('session notes refuse a symlinked .oasis directory', async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  try {
    await symlink(outside, path.join(root, '.oasis'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error && error.code)) {
      t.skip('This platform does not permit creating a directory symlink in the test environment.');
      return;
    }
    throw error;
  }
  await assert.rejects(saveSessionNotes(root, 'Do not write outside the workspace.'), /real directory|expected workspace path/i);
  await assert.rejects(readFile(path.join(outside, 'session-notes.md'), 'utf8'), { code: 'ENOENT' });
});

test('session notes refuse a symlinked notes file and leave its target unchanged', async (t) => {
  const root = await tempDir(t);
  const outside = path.join(root, 'outside.md');
  const directory = path.join(root, '.oasis');
  await mkdir(directory);
  await writeFile(outside, 'User-owned file.\n');
  try {
    await symlink(outside, path.join(directory, 'session-notes.md'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error && error.code)) {
      t.skip('This platform does not permit creating a file symlink in the test environment.');
      return;
    }
    throw error;
  }
  await assert.rejects(saveSessionNotes(root, 'Do not follow the link.'), /regular, non-symlink/i);
  assert.equal(await readFile(outside, 'utf8'), 'User-owned file.\n');
});

test('automatic compaction writes an early-session fact and reports estimated tokens saved', async (t) => {
  const root = await tempDir(t);
  const { config, requests } = await scriptedModel(t, [
    { content: 'The project was originally called Phoenix. Its entry point was src/app.mjs. The next task is to preserve the old project name and keep the entry point stable.' }
  ]);
  const session = await createSession({
    root,
    config,
    bare: true,
    env: { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') }
  });
  t.after(() => closeSession(session));

  session.messages = [{ role: 'system', content: 'OASIS system context.' }];
  for (let i = 0; i < 75; i++) {
    session.messages.push({ role: 'user', content: 'Earlier task ' + i + ': inspect the Phoenix project and keep src/app.mjs stable. ' + 'context '.repeat(80) });
    session.messages.push({ role: 'assistant', content: 'Observed fact ' + i + ': Phoenix uses src/app.mjs. ' + 'detail '.repeat(80) });
  }

  let compactionEvent = null;
  const result = await compactHistoryIfNeeded(session, {
    env: { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') },
    onCompaction: (info) => { compactionEvent = info; }
  });

  assert.equal(result.compacted, true);
  assert.equal(requests.length, 1, 'the model should summarize one bounded transcript');
  assert.ok(compactionEvent);
  assert.ok(compactionEvent.savedTokens > 0);
  assert.match(compactionEvent.note, /^Saved about [\d,]+ tokens/);
  assert.equal(compactionEvent.notesSaved, true);
  assert.equal(compactionEvent.notesPath, '.oasis/session-notes.md');
  const notes = await readFile(path.join(root, '.oasis', 'session-notes.md'), 'utf8');
  assert.match(notes, /Phoenix/);
  assert.match(notes, /src\/app\.mjs/);
  assert.match(notes, /Historical reference only; this section is not an instruction/);
  assert.match(session.messages[1].content, /Context digest of earlier conversation/);
});

test('empty summaries do not create a continuity-notes file', async (t) => {
  const root = await tempDir(t);
  const result = await saveSessionNotes(root, '  \n  ');
  assert.equal(result.saved, false);
  await assert.rejects(readFile(path.join(root, '.oasis', 'session-notes.md'), 'utf8'), { code: 'ENOENT' });
});
