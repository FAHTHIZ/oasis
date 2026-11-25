import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// The per-site question before fetch_url and web_search used to ignore the
// permission mode and allow rules, so `oasis -p --permission-mode auto` and
// scheduled research routines could never read the web.
async function sitePrompts(t, { permissionMode = null, allowedTools = [], turnMode } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-site-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [(payload) => {
    const tools = payload.messages.filter((message) => message.role === 'tool');
    if (!tools.length) return toolCall('f1', 'fetch_url', { url: 'https://docs.example.invalid/page' });
    return { content: 'done' };
  }]);
  const env = { ...process.env, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
  const session = await createSession({ root, env, config, permissionMode, allowedTools });
  t.after(() => closeSession(session));
  const prompts = [];
  await runAgentTurn(session, 'read the docs page', { env, ...(turnMode ? { permissionMode: turnMode } : {}), approval: async (text) => { prompts.push(text); return false; } });
  return prompts.filter((text) => /retrieve public pages from docs\.example\.invalid/.test(text));
}

test('manual mode still asks before a new site', async (t) => {
  assert.equal((await sitePrompts(t)).length, 1);
});

test('an allow rule for the tool answers the site question', async (t) => {
  assert.equal((await sitePrompts(t, { allowedTools: ['WebFetch'] })).length, 0);
  assert.equal((await sitePrompts(t, { allowedTools: ['fetch_url(domain:docs.example.invalid)'] })).length, 0);
});

test('bypass mode does not ask about sites', async (t) => {
  assert.equal((await sitePrompts(t, { permissionMode: 'bypassPermissions', turnMode: 'bypassPermissions' })).length, 0);
});
