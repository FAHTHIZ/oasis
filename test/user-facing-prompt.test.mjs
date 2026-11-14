import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isOasisAuthoredPrompt, userFacingPrompt, sessionRecap } from '../src/sessions.mjs';
import { savedSessionDisplay } from '../src/web.mjs';
import * as guards from '../src/turn-guards.mjs';
import { EMPTY_REPLY_NUDGE } from '../src/empty-reply.mjs';
import { MALFORMED_CALL_NUDGE } from '../src/agent-request.mjs';
import { autoTestFailurePrompt } from '../src/auto-test.mjs';
import { correctionNudge } from '../src/standing-corrections.mjs';
import { claimIssue, newClaimState } from '../src/claim-check.mjs';

const GATE = 'Before finalizing, complete the post-edit verification gate. You changed: math.mjs.\nOutstanding items: no check ran.';

test('every message OASIS adds as the user role is recognised as OASIS-authored', () => {
  const generated = [
    GATE,
    EMPTY_REPLY_NUDGE, MALFORMED_CALL_NUDGE,
    guards.GATE_FOLLOWUP_NUDGE, guards.GIVE_UP_NUDGE, guards.REFUSAL_NUDGE, guards.FALSE_CLAIM_NUDGE, guards.CONTINUE_NUDGE, guards.ACTION_NUDGE,
    guards.UNREADABLE_CALL_NUDGE(['edit_file']),
    autoTestFailurePrompt({ exitCode: 1, command: 'npm test', output: 'boom' }, 1, 2),
    correctionNudge(['Great question']),
    claimIssue(newClaimState(), 'All tests pass.', { edited: true }),
    'A Stop hook asked you to continue before finishing:\nmore',
    'A TeammateIdle hook asked you to keep working:\nmore',
    'Context digest of completed work in the current task (historical summary, not a new request):\nx',
  ];
  for (const text of generated) {
    assert.ok(text, 'generator returned text');
    assert.equal(isOasisAuthoredPrompt(text), true, text.slice(0, 80));
    assert.equal(userFacingPrompt(text), '');
  }
  assert.equal(isOasisAuthoredPrompt('fix the add function'), false);
});

test('the inline gate and hook texts still start the way the matcher expects', async () => {
  const gates = await readFile(new URL('../src/completion-gates.mjs', import.meta.url), 'utf8');
  assert.match(gates, /'Before finalizing, complete the post-edit verification gate\. You changed: '/);
  assert.match(gates, /'A ' \+ stopEvent \+ ' hook asked you to continue before finishing/);
  assert.match(gates, /'A TeammateIdle hook asked you to keep working/);
  const agent = await readFile(new URL('../src/agent.mjs', import.meta.url), 'utf8');
  assert.match(agent, /'Context digest of completed work in the current task/);
});

test('a typed prompt loses only the reminder and @file blocks OASIS appended', () => {
  const content = 'fix add\n\n<system-reminder>\nOpen follow-ups recorded in earlier sessions.\n</system-reminder>';
  assert.equal(userFacingPrompt(content), 'fix add');
  assert.equal(userFacingPrompt('look at @a.mjs\n\nReferenced files:\n<file path="a.mjs">x</file>'), 'look at @a.mjs');
  assert.equal(userFacingPrompt('line one\nline two'), 'line one\nline two', 'line breaks the user typed are kept');
});

const SAVED = {
  id: 'x', updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: [
    { role: 'system', content: 's' },
    { role: 'user', content: 'fix add\n\n<system-reminder>\nfollow-ups\n</system-reminder>' },
    { role: 'assistant', content: 'Fixed add.' },
    { role: 'user', content: GATE },
    { role: 'assistant', content: 'Checked: add(2, 3) prints 5.' },
  ],
};

test('a reopened web session shows the prompts the user typed, not gate nudges or reminders', () => {
  const users = savedSessionDisplay(SAVED.messages).filter((entry) => entry.role === 'user').map((entry) => entry.content);
  assert.deepEqual(users, ['fix add']);
});

test('the resume recap names the conversation and its last real exchange', () => {
  const recap = sessionRecap(SAVED, { width: 80 });
  assert.match(recap, /^Resumed "fix add" · 4 messages · saved 5 min ago\n/);
  assert.match(recap, /❯ fix add\n/);
  assert.match(recap, /● Checked: add\(2, 3\) prints 5\.\n$/);
  for (const line of recap.trimEnd().split('\n')) assert.ok(line.length <= 80, line);
});
