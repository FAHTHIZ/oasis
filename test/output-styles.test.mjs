import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { loadOutputStyles, systemPromptWithStyle, applyOutputStyle } from '../src/output-styles.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { createSession, closeSession } from '../src/agent.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-style-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-style-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await mkdir(path.join(root, '.oasis', 'output-styles'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'output-styles', 'pirate.md'), '---\nname: Pirate\ndescription: Talk like a pirate\n---\nAnswer like a friendly pirate.\n');
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') } };
}

test('built-in and custom output styles load and swap cleanly in the system prompt', async (t) => {
  const { root, env } = await workspace(t);
  const styles = await loadOutputStyles(root, { env, home: env.HOME });
  assert.deepEqual(Object.keys(styles).sort(), ['default', 'explanatory', 'learning', 'pirate']);
  assert.equal(styles.pirate.source, 'project');
  let prompt = systemPromptWithStyle('BASE', styles.explanatory);
  assert.match(prompt, /<output-style name="explanatory">[\s\S]*Insight/);
  prompt = systemPromptWithStyle(prompt, styles.pirate);
  assert.doesNotMatch(prompt, /explanatory/);
  assert.match(prompt, /friendly pirate/);
  assert.equal(systemPromptWithStyle(prompt, styles.default), 'BASE');
});

test('/output-style lists and switches a live session; settings pick the default style', async (t) => {
  const { root, env } = await workspace(t);
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ outputStyle: 'learning' }));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  assert.equal(session.outputStyle, 'learning');
  assert.match(session.messages[0].content, /TODO\(human\)/);
  const sessionOptions = {};
  const listed = await runBuiltinCommand('output-style', '', { root, env, session, sessionOptions });
  assert.match(listed.output, /\* learning/);
  assert.match(listed.output, /pirate .*Talk like a pirate \[project\]/);
  await runBuiltinCommand('output-style', 'pirate', { root, env, session, sessionOptions });
  assert.equal(session.outputStyle, 'pirate');
  assert.equal(sessionOptions.outputStyle, 'pirate');
  assert.doesNotMatch(session.messages[0].content, /TODO\(human\)/);
  assert.match(session.baseSystemPrompt, /friendly pirate/);
  assert.match((await runBuiltinCommand('output-style', 'nope', { root, env, session, sessionOptions })).output, /Unknown output style/);
  const missing = await createSession({ root, config, env, outputStyle: 'ghost' });
  t.after(() => closeSession(missing));
  assert.match(missing.styleWarning, /ghost/);
  assert.equal(missing.outputStyle, 'default');
});
