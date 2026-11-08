import test from 'node:test';
import assert from 'node:assert/strict';
import { webSessionState } from '../src/web.mjs';

const base = { config: { model: 'stub', protocol: 'openai-compatible' }, messages: [], permissions: { mode: 'default' } };

test('session state reports spend from the shared budget ledger, subagents included', () => {
  const state = webSessionState({ ...base, costUsd: 0.01, budgetLedger: { spentUsd: 0.05, unknownRequests: 0 } }, {});
  assert.equal(state.costUsd, 0.05);
  assert.equal(state.costPartial, false);
});

test('session state marks spend partial when a request had no known price', () => {
  const state = webSessionState({ ...base, costUsd: 0.02, budgetLedger: { spentUsd: 0.02, unknownRequests: 2 } }, {});
  assert.equal(state.costPartial, true);
});

test('session state reports zero spend for a fresh or unpriced session', () => {
  const state = webSessionState({ ...base }, {});
  assert.equal(state.costUsd, 0);
  assert.equal(state.costPartial, false);
});
