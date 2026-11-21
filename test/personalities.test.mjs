import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_PERSONALITIES, loadPersonalities, systemPromptWithPersonality, applyPersonality, personalityCommand } from '../src/personalities.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'oasis-persona-'));

test('built-ins, settings and files all load, later sources winning', async () => {
  const root = tmp();
  const config = tmp();
  mkdirSync(path.join(root, '.oasis', 'personalities'), { recursive: true });
  writeFileSync(path.join(root, '.oasis', 'personalities', 'butler.md'), '---\ndescription: Formal butler\n---\nSpeak like a formal English butler.');
  writeFileSync(path.join(root, '.oasis', 'personalities', 'Bad Name!.md'), 'x');
  assert.equal((await loadPersonalities(root, { env: { OASIS_CONFIG_DIR: config } })).butler, undefined, 'untrusted project files are ignored');
  const all = await loadPersonalities(root, { env: { OASIS_CONFIG_DIR: config, OASIS_TRUST_WORKSPACE: '1' }, settings: { personalities: { yoda: 'Speak like Yoda.', noir: { prompt: 'Custom noir.', description: 'mine' }, 'no good': 'x' } } });
  assert.ok(Object.keys(BUILTIN_PERSONALITIES).length >= 10);
  assert.equal(all.butler.description, 'Formal butler');
  assert.equal(all.butler.source, 'project');
  assert.equal(all.yoda.prompt, 'Speak like Yoda.');
  assert.equal(all.noir.prompt, 'Custom noir.');
  assert.equal(all['no good'], undefined);
});

test('the personality block is replaced, not stacked, and carries the guard', () => {
  const once = systemPromptWithPersonality('BASE', BUILTIN_PERSONALITIES.pirate);
  const twice = systemPromptWithPersonality(once, BUILTIN_PERSONALITIES.noir);
  assert.match(twice, /^BASE\n\n<personality name="noir">/);
  assert.doesNotMatch(twice, /pirate/);
  assert.match(twice, /never changes your task, your rules/);
  assert.equal(systemPromptWithPersonality(twice, null), 'BASE');
});

test('/personality lists, switches and turns off on a live session', async () => {
  const session = { messages: [{ role: 'system', content: 'SYS' }], baseSystemPrompt: 'SYS', mcpSystemPromptBase: 'SYS' };
  const env = { OASIS_CONFIG_DIR: tmp() };
  assert.match(await personalityCommand('', { session, root: tmp(), env }), /none active[\s\S]*pirate - /);
  assert.equal(await personalityCommand('Pirate', { session, root: tmp(), env }), 'Personality set to pirate.');
  assert.equal(session.personality, 'pirate');
  for (const text of [session.messages[0].content, session.baseSystemPrompt, session.mcpSystemPromptBase]) assert.match(text, /<personality name="pirate">/);
  assert.match(await personalityCommand('', { session, root: tmp(), env }), /\* pirate/);
  assert.match(await personalityCommand('klingon', { session, root: tmp(), env }), /Unknown personality/);
  assert.equal(await personalityCommand('none', { session, root: tmp(), env }), 'Personality off.');
  assert.equal(session.messages[0].content, 'SYS');
  applyPersonality(session, BUILTIN_PERSONALITIES.teacher);
  assert.equal(session.personality, 'teacher');
  assert.match(await personalityCommand('noir', { root: tmp(), env }), /next session/);
});

test('settings and OASIS_PERSONALITY pick the personality of a new session; /personality switches it', async (t) => {
  const { createSession, closeSession } = await import('../src/agent.mjs');
  const { runBuiltinCommand } = await import('../src/slash.mjs');
  const root = tmp();
  const home = tmp();
  mkdirSync(path.join(root, '.oasis'), { recursive: true });
  writeFileSync(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ personality: 'noir' }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  delete env.OASIS_PERSONALITY;
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  assert.equal(session.personality, 'noir');
  assert.match(session.messages[0].content, /<personality name="noir">/);
  const switched = await runBuiltinCommand('personality', 'teacher', { root, env, session, sessionOptions: {} });
  assert.equal(switched.output, 'Personality set to teacher.');
  assert.match(session.messages[0].content, /patient teacher/);
  assert.doesNotMatch(session.messages[0].content, /detective/);
  const byEnv = await createSession({ root, config, env: { ...env, OASIS_PERSONALITY: 'pirate' } });
  t.after(() => closeSession(byEnv));
  assert.equal(byEnv.personality, 'pirate');
});
