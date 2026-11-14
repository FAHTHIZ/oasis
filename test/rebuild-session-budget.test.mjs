import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, rebuildSession, closeSession } from '../src/agent.mjs';
import { chargeRequestAttempt } from '../src/cost-policy.mjs';

// /reload-plugins rebuilds the session. It used to start a fresh spend ledger,
// so --max-budget-usd and --max-requests silently restarted from zero.
test('reloading plugins keeps the spend and request ledger', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-rebuild-budget-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_MAX_REQUESTS: '7', OASIS_TELEMETRY: '0' };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9', apiKey: 'k', model: 'm' };
  const first = await createSession({ root: dir, config, env, maxBudgetUsd: 1 });
  first.costUsd = 0.9;
  first.budgetLedger = { spentUsd: 0.9, unknownRequests: 0, requests: 7, tokens: 1000 };
  first.lastRunReport = { outcome: 'finished' };
  const { session } = await rebuildSession(first, { env, maxBudgetUsd: 1 });
  try {
    assert.equal(session.costUsd, 0.9);
    assert.equal(session.budgetLedger.spentUsd, 0.9);
    assert.equal(session.lastRunReport.outcome, 'finished');
    assert.throws(() => chargeRequestAttempt(session, { env }), (error) => error.code === 'REQUEST_BUDGET_EXCEEDED');
  } finally { await closeSession(session); await rm(dir, { recursive: true, force: true }); }
});
