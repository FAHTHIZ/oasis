import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreAgentHistory, drainInbox, agentStatus } from '../src/agent-tasks.mjs';
import { sanitizeAgentHistory } from '../src/sessions.mjs';

const base = { type: 'general-purpose', parentId: 'main', startedAt: 1, report: 'All findings here.', background: true };

test('an unread background result and an interrupted worker are announced after a restart', () => {
  const saved = sanitizeAgentHistory([
    { ...base, id: 'agent_1', description: 'read docs', status: 'completed', noticeRead: false },
    { ...base, id: 'agent_2', description: 'already read', status: 'completed', noticeRead: true },
    { ...base, id: 'agent_3', description: 'long build', status: 'running', transcriptSaved: true },
    { ...base, id: 'agent_4', description: 'foreground', status: 'completed', background: false }
  ]);
  assert.equal(saved[0].noticePending, true);
  assert.equal(saved[1].noticePending, undefined);
  assert.equal(saved[2].noticePending, undefined);
  assert.equal(saved[3].noticePending, undefined);
  const session = {};
  restoreAgentHistory(session, saved);
  const text = drainInbox(session);
  assert.match(text, /OASIS restarted since your last turn/);
  assert.match(text, /agent_1 \("read docs"\) completed before the restart/);
  assert.doesNotMatch(text, /agent_2|agent_4/);
  assert.match(text, /agent_3 \("long build"\) was still running/);
  // Delivered once: the next save no longer marks it, and a second restart is quiet.
  const again = sanitizeAgentHistory(session.agentTasks);
  assert.ok(again.every((item) => !item.noticePending));
  const next = {};
  restoreAgentHistory(next, again);
  assert.equal(drainInbox(next), '');
});

test('reading the result with agent_status drops the pending notice', async () => {
  const saved = sanitizeAgentHistory([{ ...base, id: 'agent_1', description: 'read docs', status: 'completed', noticeRead: false }]);
  const session = {};
  restoreAgentHistory(session, saved);
  const status = await agentStatus(session, { id: 'agent_1' });
  assert.equal(status.report, 'All findings here.');
  assert.equal(drainInbox(session), '');
  assert.ok(sanitizeAgentHistory(session.agentTasks).every((item) => !item.noticePending));
});
