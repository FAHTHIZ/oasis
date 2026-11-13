// Completion gates in isolation: the decisions taken when a model reply has
// no tool call, without a provider or the full agent loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newGateState, runCompletionGates } from '../src/completion-gates.mjs';
import { newClaimState } from '../src/claim-check.mjs';

function verificationState() {
  return { changedPaths: new Set(), diffReviewedPaths: new Set(), diffReviewedAll: false, overwrittenPaths: new Set(), lastVerificationExitCode: null, lastVerificationKind: null, lspVerificationByPath: new Map(), nudgeUsed: false };
}

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shown = [];
  const host = {
    emitDisplayText: async (_session, _options, text) => { shown.push(text); },
    pruneHistory: () => {},
    recordSessionEvent: () => {},
    hookOptions: () => ({}),
    availableToolNames: () => new Set(['read_file', 'edit_file', 'mcp__x__y'])
  };
  const session = { root, messages: [], hookMessages: [], config: {}, settings: {} };
  const gates = newGateState();
  const verification = verificationState();
  const claimState = newClaimState();
  const turn = (text, assistant = {}, extra = {}) => {
    const assistantMessage = { role: 'assistant', content: text };
    session.messages.push(assistantMessage);
    return { session, options: { isSubagent: true, onText: () => {}, ...extra.options }, request: extra.request || 'what does this repo do?', text, assistant, assistantMessage, verification, claimState, gates, totals: { toolCalls: 3, tokensUsed: 10, tokenBudget: 100 } };
  };
  return { host, session, gates, verification, turn, shown };
}

test('a plain answer with nothing outstanding finishes the turn with the totals', async (t) => {
  const h = await harness(t);
  const outcome = await runCompletionGates(h.turn('It is a CLI.'), h.host);
  assert.equal(outcome.type, 'finish');
  assert.equal(outcome.result.text, 'It is a CLI.');
  assert.equal(outcome.result.finished, true);
  assert.equal(outcome.result.toolCalls, 3);
  assert.equal(outcome.result.budgetExceeded, false);
  assert.deepEqual(h.shown, ['It is a CLI.']);
});

test('an empty reply is asked again a bounded number of times, then reported', async (t) => {
  const h = await harness(t);
  let outcome;
  let asks = 0;
  for (let i = 0; i < 10; i++) {
    outcome = await runCompletionGates(h.turn(''), h.host);
    if (outcome.type !== 'continue') break;
    asks++;
    // The empty reply is dropped from history before the re-ask.
    assert.equal(h.session.messages.at(-1).role, 'user');
  }
  assert.ok(asks >= 1 && asks < 10, 'asks ' + asks);
  assert.equal(outcome.type, 'finish');
  assert.equal(outcome.result.emptyReply, true);
  assert.equal(outcome.result.finished, true);
});

test('a provider-side stop is reported at once instead of retried', async (t) => {
  const h = await harness(t);
  const outcome = await runCompletionGates(h.turn('', { providerStop: 'content_filter' }), h.host);
  assert.equal(outcome.type, 'finish');
  assert.match(outcome.result.text, /finish reason: content_filter/);
});

test('invented tool names get two corrections that list real tools, then the turn ends', async (t) => {
  const h = await harness(t);
  const results = [];
  for (let i = 0; i < 3; i++) results.push((await runCompletionGates(h.turn('Done.', { unknownToolNames: ['deploy_site'] }), h.host)).type);
  assert.deepEqual(results, ['continue', 'continue', 'finish']);
  const note = h.session.messages.find((m) => m.role === 'user' && /deploy_site is not a tool/.test(m.content));
  assert.ok(note);
  assert.match(note.content, /read_file, edit_file/);
  assert.doesNotMatch(note.content, /mcp__x__y/);
});

test('open checklist steps written this turn hold the answer back once', async (t) => {
  const h = await harness(t);
  h.session.todos = [{ content: 'write docs', status: 'in_progress' }, { content: 'plan', status: 'completed' }];
  assert.equal((await runCompletionGates(h.turn('All done.'), h.host)).type, 'finish', 'a stale checklist does not block');
  h.gates.todosWrittenThisTurn = true;
  const first = await runCompletionGates(h.turn('All done.'), h.host);
  assert.equal(first.type, 'continue');
  assert.match(h.session.messages.at(-1).content, /\[in_progress\] write docs/);
  assert.doesNotMatch(h.session.messages.at(-1).content, /plan/);
  assert.equal((await runCompletionGates(h.turn('All done.'), h.host)).type, 'finish');
});

test('an edit with no review or check is sent back through the verification gate once', async (t) => {
  const h = await harness(t);
  h.verification.changedPaths.add('src/app.mjs');
  const first = await runCompletionGates(h.turn('Fixed it.'), h.host);
  assert.equal(first.type, 'continue');
  assert.match(h.session.messages.at(-1).content, /verification gate. You changed: src\/app\.mjs/);
  const second = await runCompletionGates(h.turn('Fixed it.'), h.host);
  assert.equal(second.type, 'finish');
  assert.equal(second.result.finished, false);
  assert.equal(second.result.verificationIncomplete, true);
  assert.ok(second.result.verificationIssues.length >= 1);
});

test('user steering during the reply hands the model the message instead of finishing', async (t) => {
  const h = await harness(t);
  h.session.steering = [{ text: 'use tabs', at: 0 }];
  const outcome = await runCompletionGates(h.turn('Here you go.', {}, { options: { isSubagent: false } }), h.host);
  assert.equal(outcome.type, 'continue');
  assert.deepEqual(h.shown, ['Here you go.']);
  assert.match(h.session.messages.at(-1).content, /use tabs/);
  assert.equal(h.session.steering.length, 0);
});

test('gate counters start fresh for every turn', () => {
  const a = newGateState();
  a.actionNudges = 2;
  assert.equal(newGateState().actionNudges, 0);
});
