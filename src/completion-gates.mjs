// Completion gates: what happens when the model replies without a tool call.
//
// A reply with no tool call is the model saying "I am done". Before the turn
// ends, OASIS checks that claim in a fixed order: pending steering, automatic
// tests and static parsing, unreadable or invented tool calls, replies that
// describe work instead of doing it, open checklist steps, empty replies, the
// post-edit verification gate, unbacked claims, standing corrections and the
// Stop/TeammateIdle hooks. The first gate that objects decides the outcome:
//
//   { type: 'continue' }                  a note was added; ask the model again
//   { type: 'apply', calls, batch }       run these harness-made tool calls
//                                         (batch: 'fenced' | 'assisted')
//   { type: 'finish', result }            the turn is over; result is returned
//
// Per-turn counters (how many nudges of each kind were spent) live in the
// state from newGateState(), so each gate fires a bounded number of times.
// Agent-owned helpers come in through `host`, which keeps this module free of
// an import cycle with agent.mjs.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { runHooks, hasHooks, capHookText } from './hooks.mjs';
import { claimIssue, recordCheck as recordClaimCheck, appendUnverifiedNotice, failedEditIssue, appendFailedEditNotice } from './claim-check.mjs';
import { correctionViolations, correctionNudge } from './standing-corrections.mjs';
import { extractFollowups, recordFollowups, followupsEnabled } from './followups.mjs';
import { deliverSteering, pendingSteering } from './steering.mjs';
import { formatLspVerificationBlocker, verificationSummary } from './verification-summary.mjs';
import { permissionMode } from './plan-mode.mjs';
import {
  ACTION_NUDGE, CONTINUE_NUDGE, EMPTY_REPLY_NOTICE, EMPTY_REPLY_NUDGE, FALSE_CLAIM_NUDGE, GIVE_UP_NUDGE, MAX_EMPTY_REPLY_NUDGES, providerStopNotice, providerCutNotice,
  REFUSAL_NUDGE, SOURCE_EXTENSIONS, UNREADABLE_CALL_NUDGE, GATE_FOLLOWUP_NUDGE, NEW_TEST_FOLLOWUP_NUDGE, announcesNextStep, announcesTerseStep, appendLspUnavailableNotice, asksForAction,
  assistedVerificationCalls, assistedVerificationEnabled, claimsUnmadeChange, fencedFileFromReply, givesUpEarly, normalizeReviewPath,
  readsLikeInstructions, refusesSpuriously, relatedTestsHint, targetFileHint, untestedNewCode, verificationIssues, wrongFileNudge
} from './turn-guards.mjs';

const CONTINUE = Object.freeze({ type: 'continue' });

/** Fresh per-turn gate counters. */

// The Stop hook payload carries the whole final reply (Claude Code sends it
// uncut). A hook that checks the conclusion, a "DONE" marker or a test
// summary at the end, must see the end, so a very long reply keeps its head
// and tail around a marker instead of being cut at 4,000 characters.
export const MAX_STOP_HOOK_MESSAGE_CHARS = 100_000;
export function stopHookMessage(text) {
  const value = String(text || '');
  if (value.length <= MAX_STOP_HOOK_MESSAGE_CHARS) return value;
  const head = Math.floor(MAX_STOP_HOOK_MESSAGE_CHARS * 0.3);
  const tail = MAX_STOP_HOOK_MESSAGE_CHARS - head;
  return value.slice(0, head) + '\n[' + (value.length - head - tail) + ' characters omitted]\n' + value.slice(-tail);
}

export function newGateState() {
  return {
    unknownToolNudges: 0,
    echoNudges: 0,
    actionNudges: 0,
    fencedApplied: false,
    refusalNudged: false,
    wrongFileNudged: false,
    openTodoNudged: false,
    emptyReplyNudges: 0,
    emptyReply: false,
    correctionNudged: false,
    stopHookContinuations: 0,
    // Set by the tool loop when todo_write succeeds: only a checklist this
    // turn worked on may hold the answer back.
    todosWrittenThisTurn: false
  };
}

/**
 * Decides what a tool-free reply leads to. `turn` holds { session, options,
 * request, text, assistant, assistantMessage, verification, claimState,
 * gates (from newGateState), totals: { toolCalls, tokensUsed, tokenBudget } }.
 * `host` supplies { emitDisplayText, pruneHistory, recordSessionEvent,
 * hookOptions, availableToolNames } from the agent.
 */
export async function runCompletionGates(turn, host) {
  const { session, options, request, text, assistant, assistantMessage, verification, claimState, totals } = turn;
  const g = turn.gates;
  const { emitDisplayText, pruneHistory, recordSessionEvent, hookOptions, availableToolNames } = host;
  // The user steered while this reply was generating: show the reply, then
  // hand the model their message instead of ending the turn.
  if (!options.isSubagent && pendingSteering(session)) {
    if (text && options.onText) await emitDisplayText(session, options, text);
    deliverSteering(session, options);
    return CONTINUE;
  }
  if (verification.autoTestPending && verification.changedPaths.size && !options.isSubagent) {
    verification.autoTestPending = false;
    const { resolveAutoTest, runAutoTest, autoTestFailurePrompt } = await import('./auto-test.mjs');
    const autoTest = resolveAutoTest(session.settings, options.env || process.env);
    if (autoTest && (verification.autoTestAttempts || 0) < autoTest.maxAttempts) {
      verification.autoTestAttempts = (verification.autoTestAttempts || 0) + 1;
      const call = { id: 'auto_test_' + verification.autoTestAttempts, type: 'function', function: { name: 'auto_test', arguments: JSON.stringify({ command: autoTest.command }) } };
      if (options.onToolStart) options.onToolStart({ name: 'auto_test', call, args: { command: autoTest.command } });
      const outcome = await runAutoTest(session.root, autoTest.command, { timeoutMs: autoTest.timeoutMs, signal: options.signal, env: { ...process.env, ...(session.settings && session.settings.env || {}) }, sandbox: session.sandbox });
      if (options.onToolResult) options.onToolResult({ name: 'auto_test', call, result: { command: outcome.command, exitCode: outcome.exitCode, passed: outcome.passed, timedOut: outcome.timedOut, durationMs: outcome.durationMs, output: outcome.output.slice(-2000) } });
      recordClaimCheck(claimState, { command: autoTest.command, exitCode: outcome.exitCode });
      verification.lastVerificationExitCode = outcome.passed ? 0 : outcome.exitCode || 1;
      verification.lastVerificationKind = 'test';
      recordSessionEvent(session, { type: 'verification', kind: 'test', command: String(outcome.command || autoTest.command).slice(0, 300), exitCode: outcome.exitCode, passed: Boolean(outcome.passed), automatic: true }, options.env);
      verification.autoTestLast = { command: outcome.command, exitCode: outcome.exitCode, passed: outcome.passed, attempts: verification.autoTestAttempts };
      if (outcome.cancelled) throw Object.assign(new Error('Agent task cancelled by the user.'), { name: 'AbortError' });
      if (!outcome.passed) {
        if (text && options.onText) await emitDisplayText(session, options, text);
        session.messages.push({ role: 'user', content: autoTestFailurePrompt(outcome, verification.autoTestAttempts, autoTest.maxAttempts) });
        return CONTINUE;
      }
    }
  }
  // HTML, CSS, JSON, YAML and TOML have no test runner to call. When they
  // (plus any scripts already run cleanly) are the whole change, parse
  // them in-process: a clean parse is the check, problems go back to the
  // model to fix. See src/static-check.mjs.
  if (verification.staticCheckPending && verification.changedPaths.size && verification.lastVerificationExitCode !== 0 && !options.planOnly) {
    verification.staticCheckPending = false;
    const { staticFileCheck, STATIC_CHECK_EXTENSIONS } = await import('./static-check.mjs');
    const sources = [...verification.changedPaths].filter((item) => SOURCE_EXTENSIONS.has(path.extname(item).toLowerCase()));
    const staticFiles = sources.filter((item) => !(verification.ranPaths && verification.ranPaths.has(item)) && (STATIC_CHECK_EXTENSIONS.has(path.extname(item).toLowerCase()) || /\.m?js$/i.test(item)));
    if (staticFiles.length && sources.every((item) => staticFiles.includes(item) || (verification.ranPaths && verification.ranPaths.has(item)))) {
      // .js counts only when a page loads it (browser script); otherwise checked is short and nothing changes.
      const { checked, problems } = await staticFileCheck(session.root, staticFiles);
      if (checked.length === staticFiles.length) {
        verification.lastVerificationExitCode = problems.length ? 1 : 0;
        verification.lastVerificationKind = 'static';
        recordSessionEvent(session, { type: 'verification', kind: 'static', command: 'parse ' + checked.join(' ').slice(0, 280), exitCode: problems.length ? 1 : 0, passed: !problems.length, automatic: true }, options.env);
        if (problems.length && (verification.staticFixes || 0) < 2) {
          verification.staticFixes = (verification.staticFixes || 0) + 1;
          if (text && options.onText) await emitDisplayText(session, options, text);
          session.messages.push({ role: 'user', content: '<system-reminder>OASIS parsed the files you changed and found problems:\n' + problems.map((item) => '- ' + item).join('\n') + '\nFix them (create any missing file the page refers to, or change the reference), then finish. Do not mention this note.</system-reminder>' });
          return CONTINUE;
        }
      }
    }
  }
  if (verification.tamperCheckPending && verification.changedPaths.size) {
    verification.tamperCheckPending = false;
    const { inspectTestChanges, isTestPath } = await import('./test-tamper.mjs');
    const changes = await inspectTestChanges(session.root, [...verification.changedPaths]);
    verification.testTampering = changes.tampering;
    // Files the agent created are untracked, so absent from the diff; a new test file is a new test.
    const created = verification.createdPaths instanceof Set ? verification.createdPaths : new Set();
    verification.testsOnlyExtended = [...verification.changedPaths].some((item) => created.has(item) && isTestPath(item)) ? [] : changes.extendedOnly;
  }
  if (assistant.unreadableToolCalls && g.unknownToolNudges < 2) {
    g.unknownToolNudges++;
    session.messages.push({ role: 'user', content: UNREADABLE_CALL_NUDGE(assistant.unreadableToolCalls) });
    return CONTINUE;
  }
  if (assistant.unknownToolNames && g.unknownToolNudges < 2) {
    g.unknownToolNudges++;
    const names = [...availableToolNames(session)].filter((name) => !name.includes('__')).slice(0, 30);
    session.messages.push({ role: 'user', content: '<system-reminder>' + assistant.unknownToolNames.join(', ') + (assistant.unknownToolNames.length === 1 ? ' is not a tool' : ' are not tools') + ', so nothing ran. Available tools: ' + names.join(', ') + '. Do only what the user asked (do not commit or push unless asked). Call a real tool now, or give your final answer.</system-reminder>' });
    return CONTINUE;
  }
  if (!text && assistant.echoedToolResponse && g.echoNudges < 2) {
    g.echoNudges++;
    session.messages.push({ role: 'user', content: '<system-reminder>You wrote a tool result yourself instead of replying. Tool results come only from OASIS. Continue the task: call a tool, or give your final answer to the user in plain text.</system-reminder>' });
    return CONTINUE;
  }
  // After one nudge, a reply that still holds the new file in a code block
  // is applied with write_file (small/local models only, new files only,
  // through the normal tool path and permissions).
  if (g.actionNudges >= 1 && !g.fencedApplied && !verification.changedPaths.size && !options.planOnly && permissionMode(session, options) !== 'plan' && asksForAction(request) && assistedVerificationEnabled(session, options.env || process.env)) {
    const fenced = fencedFileFromReply(request, text);
    let exists = true;
    if (fenced) { try { await stat(path.join(session.root, fenced.path)); } catch { exists = false; } }
    if (fenced && !exists) {
      g.fencedApplied = true;
      const calls = [{ id: 'oasis_apply_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify(fenced) } }];
      assistantMessage.tool_calls = calls;
      return { type: 'apply', calls, batch: 'fenced' }; // the text is shown once below, with the calls
    }
  }
  // The model created the file this turn, a check failed, and it answered
  // with the corrected whole file in a code block instead of editing. Apply
  // it (twice at most; whole-file replacements of its own new file only).
  if ((verification.fencedFixes || 0) < 2 && verification.createdPaths && verification.createdPaths.size && verification.lastVerificationExitCode != null && verification.lastVerificationExitCode !== 0 && !options.planOnly && permissionMode(session, options) !== 'plan' && assistedVerificationEnabled(session, options.env || process.env)) {
    const fenced = fencedFileFromReply(request, text);
    if (fenced && verification.createdPaths.has(normalizeReviewPath(fenced.path))) {
      let current = '';
      try { current = await readFile(path.join(session.root, fenced.path), 'utf8'); } catch { current = ''; }
      if (current && fenced.content.trim() !== current.trim() && fenced.content.length >= current.length * 0.6) {
        verification.fencedFixes = (verification.fencedFixes || 0) + 1;
        // Leave room for one more harness-run check of the replaced file.
        verification.assistedRuns = Math.min(verification.assistedRuns || 0, 1);
        const calls = [{ id: 'oasis_apply_fix_' + verification.fencedFixes, type: 'function', function: { name: 'write_file', arguments: JSON.stringify(fenced) } }];
        assistantMessage.tool_calls = calls;
        return { type: 'apply', calls, batch: 'fenced' };
      }
    }
  }
  // A canned refusal stays in context and small models then repeat it, so
  // drop it (and a scolding nudge just before it) and retry with a plain,
  // neutral instruction. Once per turn, small or local models only.
  if (!g.refusalNudged && !verification.changedPaths.size && !options.planOnly && permissionMode(session, options) !== 'plan' && asksForAction(request) && refusesSpuriously(text) && assistedVerificationEnabled(session, options.env || process.env)) {
    g.refusalNudged = true;
    if (session.messages[session.messages.length - 1] === assistantMessage) session.messages.pop();
    const previous = session.messages[session.messages.length - 1];
    if (previous && previous.role === 'user' && typeof previous.content === 'string' && previous.content.startsWith('<system-reminder>')) session.messages.pop();
    if (typeof options.onActionNudge === 'function') { try { options.onActionNudge({ kind: 'refused' }); } catch {} }
    session.messages.push({ role: 'user', content: REFUSAL_NUDGE + targetFileHint(request) });
    return CONTINUE;
  }
  // Smaller models often answer "create X" with a tutorial instead of doing it.
  // They also announce the next step ("I need to create the file") and stop.
  if (g.actionNudges < 2 && !verification.changedPaths.size && !options.planOnly && permissionMode(session, options) !== 'plan' && asksForAction(request)) {
    const kind = !String(text || '').trim() ? 'empty' : claimsUnmadeChange(text) ? 'false-claim' : readsLikeInstructions(text) ? 'described' : announcesNextStep(text) ? 'announced' : givesUpEarly(text) ? 'gave-up' : '';
    if (kind) {
      g.actionNudges++;
      // A false "I created it" in context gets repeated by small models; drop it.
      if (kind === 'false-claim' && assistedVerificationEnabled(session, options.env || process.env) && session.messages[session.messages.length - 1] === assistantMessage) session.messages.pop();
      if (typeof options.onActionNudge === 'function') { try { options.onActionNudge({ kind }); } catch {} }
      session.messages.push({ role: 'user', content: kind === 'false-claim' ? FALSE_CLAIM_NUDGE + targetFileHint(request) : kind === 'described' ? ACTION_NUDGE : kind === 'gave-up' ? GIVE_UP_NUDGE : CONTINUE_NUDGE });
      return CONTINUE;
    }
  }
  if (!g.wrongFileNudged && !options.planOnly && permissionMode(session, options) !== 'plan') {
    const nudge = wrongFileNudge(request, verification, (relative) => { try { return existsSync(path.resolve(session.root || process.cwd(), relative)); } catch { return true; } });
    if (nudge) {
      g.wrongFileNudged = true;
      if (typeof options.onActionNudge === 'function') { try { options.onActionNudge({ kind: 'wrong-file' }); } catch {} }
      session.messages.push({ role: 'user', content: nudge });
      return CONTINUE;
    }
  }
  // A final answer while the model's own checklist still has open steps is
  // the clearest false "done": send it back once to finish those steps or
  // to update the checklist and say plainly what is unfinished.
  const openTodos = Array.isArray(session.todos) ? session.todos.filter((item) => item && item.status !== 'completed') : [];
  if (text && openTodos.length && g.todosWrittenThisTurn && !g.openTodoNudged && !options.planOnly && permissionMode(session, options) !== 'plan') {
    g.openTodoNudged = true;
    if (typeof options.onActionNudge === 'function') { try { options.onActionNudge({ kind: 'open-todos' }); } catch {} }
    session.messages.push({ role: 'user', content: '<system-reminder>Your checklist still has open steps:\n' + openTodos.map((item) => '- [' + item.status + '] ' + item.content).join('\n') + '\nFinish them now, or, if they cannot or should not be done, update the checklist with todo_write and tell the user plainly which steps are unfinished and why. Do not report the task as complete while steps are open.</system-reminder>' });
    return CONTINUE;
  }
  // An empty reply (no text, no tool call) is not an answer: it used to end
  // the turn as "finished" with nothing to show. Ask again, then say so.
  if (!text) {
    // A provider-side stop (content filter, refusal, error finish) comes back
    // the same way on a re-ask, so it is reported instead of retried.
    if (assistant.providerStop) g.emptyReplyNudges = MAX_EMPTY_REPLY_NUDGES;
    if (g.emptyReplyNudges < MAX_EMPTY_REPLY_NUDGES) {
      g.emptyReplyNudges++;
      if (session.messages[session.messages.length - 1] === assistantMessage) session.messages.pop();
      if (typeof options.onActionNudge === 'function') { try { options.onActionNudge({ kind: 'empty' }); } catch {} }
      session.messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE });
      return CONTINUE;
    }
    g.emptyReply = true;
  }
  const issues = verificationIssues(verification);
  const blockedText = verification.nudgeUsed ? formatLspVerificationBlocker(issues) : null;
  if (blockedText) {
    assistantMessage.content = blockedText;
    if (options.onText) await emitDisplayText(session, options, blockedText);
    pruneHistory(session);
    return { type: 'finish', result: {
      text: blockedText,
      toolCalls: totals.toolCalls,
      tokensUsed: totals.tokensUsed,
      tokenBudget: totals.tokenBudget,
      finished: false,
      verificationIncomplete: true,
      verificationIssues: issues,
      verification: verificationSummary(verification),
      budgetExceeded: (totals.budgetTokensUsed ?? totals.tokensUsed) > totals.tokenBudget
    } };
  }
  // Small and local models often fumble the mechanical part of the gate
  // (they tell the user to run git diff). The harness runs the review and
  // the project's own test command for them, through the normal tool path
  // and permissions, and hands back the results.
  if (issues.length && (verification.assistedRuns || 0) < 2 && assistedVerificationEnabled(session, options.env || process.env)) {
    const checks = await assistedVerificationCalls(session.root, verification);
    if (checks.length) {
      verification.assistedRuns = (verification.assistedRuns || 0) + 1;
      const calls = checks.map((check, index) => ({ id: 'oasis_check_' + verification.assistedRuns + '_' + index, type: 'function', function: { name: check.name, arguments: JSON.stringify(check.args) } }));
      verification.syntaxCheckIds = new Set(checks.map((check, index) => check.syntax ? 'oasis_check_' + verification.assistedRuns + '_' + index : null).filter(Boolean));
      assistantMessage.tool_calls = calls;
      return { type: 'apply', calls, batch: 'assisted' }; // the text is shown once below, with the calls
    }
  }
  // After the gate note, a reply that only names the next check ("Check util
  // diff.") is not a final answer: ask once more for the step itself.
  if (issues.length && verification.nudgeUsed && !verification.followupNudged && (announcesNextStep(text) || announcesTerseStep(text))) {
    verification.followupNudged = true;
    session.messages.push({ role: 'user', content: GATE_FOLLOWUP_NUDGE + '\nStill outstanding: ' + issues.join('; ') + '.' });
    return CONTINUE;
  }
  if (issues.length && verification.nudgeUsed && !verification.newTestNudged && !options.planOnly && issues.some((issue) => /^the request asked for (?:new tests|a new test)/.test(issue))) {
    verification.newTestNudged = true;
    if (typeof options.onActionNudge === 'function') { try { options.onActionNudge({ kind: 'new-test' }); } catch {} }
    session.messages.push({ role: 'user', content: NEW_TEST_FOLLOWUP_NUDGE });
    return CONTINUE;
  }
  if (issues.length && !verification.nudgeUsed) {
    verification.nudgeUsed = true;
    const relatedHint = issues.some((issue) => /has passed after the latest code edit/.test(issue)) ? await relatedTestsHint(session.root, verification.changedPaths) : '';
    // A streamed reply is already on screen; say why work continues.
    if (typeof options.onVerificationGate === 'function') {
      const stale = claimState.ran && claimState.editedAfter && claimState.lastCommand ? claimState.lastCommand : '';
      const steps = issues.map((issue) => /diff has not been reviewed/.test(issue) ? 'review the diff of ' + (/\(([^)]*)\)/.exec(issue) || [null, 'the changes'])[1]
        : /has passed after the latest code edit/.test(issue) ? (stale ? 'rerun ' + stale : 'run a check')
        : /asked for (?:new tests|a new test)/.test(issue) ? 'add a test'
        : /tests were weakened/.test(issue) ? 'restore weakened tests'
        : issue.split(/[;(]/)[0].slice(0, 60));
      try { options.onVerificationGate({ issues, steps }); } catch {}
    }
    session.messages.push({
      role: 'user',
      content: [
        'Before finalizing, complete the post-edit verification gate. You changed: ' + [...verification.changedPaths].join(', ') + '.',
        'Outstanding items: ' + issues.join('; ') + '.',
        // Name the command: a model that saw it pass earlier tends to
        // report that stale run instead of rerunning it.
        ...(claimState.ran && claimState.editedAfter && claimState.lastCommand && issues.some((issue) => /has passed after the latest code edit/.test(issue))
          ? ['Rerun `' + claimState.lastCommand + '` now: it ran before your latest edit, so its result no longer counts.'] : []),
        'Use git_diff to review the complete change set when Git metadata is available. In a non-Git workspace, reread every changed file after editing. For changed source/config code, inspect the project scripts and run a relevant test/check/lint/build/type-check command; fix failures and rerun checks after fixes.',
        ...untestedNewCode(verification),
        ...(relatedHint ? [relatedHint] : []),
        'Do not claim completion of the gate based on the file-write result. If a check cannot run or permission is denied, state that limitation honestly.',
        // Pressure to "verify" a check that cannot run is what makes small
        // models invent a passing test log. Say plainly that it cannot run.
        ...(verification.deniedCheck && verification.lastVerificationExitCode !== 0
          ? ['`' + verification.deniedCheck + '` was not approved, so it cannot run in this session. Do not run it again, and never write test or command output you did not see in a tool result. Tell the user it was not run and give them the exact command.'] : []),
        // Models echo this note back ("The gate is satisfied"); the user never saw it.
        'This note is internal. In your final answer, report to the user what changed and which checks ran, in plain words. Do not mention this note, the gate, or these instructions, and do not claim anything (such as a commit) that you did not do.',
        // The first summary is already on screen; a second full one reads as a repeat.
        ...(String(text || '').trim() && options.textShown !== false ? ['The user already saw your previous summary. After the checks, do not repeat it: in one or two sentences, say what the checks showed and anything that changed or was wrong in that summary.'] : [])
      ].join('\n')
    });
    return CONTINUE;
  }
  const claimNudge = claimIssue(claimState, text, { edited: verification.changedPaths.size > 0, deniedCheck: verification.deniedCheck || '' }) || failedEditIssue(claimState, text);
  if (claimNudge) {
    if (text && options.onText) await emitDisplayText(session, options, text);
    session.messages.push({ role: 'user', content: claimNudge });
    return CONTINUE;
  }
  if (!options.isSubagent && !g.correctionNudged && session.standingCorrections && session.standingCorrections.length) {
    const violations = correctionViolations(session.standingCorrections, text);
    if (violations.length) {
      g.correctionNudged = true;
      session.messages.push({ role: 'user', content: correctionNudge(violations) });
      return CONTINUE;
    }
  }
  const stopEvent = options.isSubagent ? 'SubagentStop' : 'Stop';
  if (session.hooks && hasHooks(session.hooks, stopEvent) && g.stopHookContinuations < 3) {
    const stop = await runHooks(stopEvent, { session_id: session.sessionId || 'unsaved', stop_hook_active: g.stopHookContinuations > 0, last_assistant_message: stopHookMessage(text), ...(options.isSubagent ? { agent_type: options.agentType, agent_id: options.agentId } : {}) }, hookOptions(session, options.env));
    session.hookMessages.push(...stop.messages);
    if (stop.blocked && !stop.stopContinuation) {
      g.stopHookContinuations++;
      if (text && options.onText) await emitDisplayText(session, options, text);
      session.messages.push({ role: 'user', content: 'A ' + stopEvent + ' hook asked you to continue before finishing:\n' + capHookText(stop.reason) });
      return CONTINUE;
    }
  }
  // TeammateIdle: a team member is about to go idle. Exit 2 keeps it working; continue:false stops it.
  if (options.teammate && session.hooks && hasHooks(session.hooks, 'TeammateIdle') && g.stopHookContinuations < 3) {
    const idle = await runHooks('TeammateIdle', { session_id: session.sessionId || 'unsaved', teammate_name: options.teammate.name, team_name: options.teammate.team, agent_id: options.agentId }, hookOptions(session, options.env));
    session.hookMessages.push(...idle.messages);
    if (idle.blocked && !idle.stopContinuation) {
      g.stopHookContinuations++;
      if (text && options.onText) await emitDisplayText(session, options, text);
      session.messages.push({ role: 'user', content: 'A TeammateIdle hook asked you to keep working:\n' + capHookText(idle.reason) });
      return CONTINUE;
    }
  }
  const shownText = assistant.providerStop && text ? text.replace(/\s+$/, '') + '\n\n' + providerCutNotice(assistant.providerStop) : text;
  const finalText = g.emptyReply ? (assistant.providerStop ? providerStopNotice(assistant.providerStop) : EMPTY_REPLY_NOTICE) : appendFailedEditNotice(issues.length ? appendUnverifiedNotice(shownText, issues, verification, claimState) : appendLspUnavailableNotice(shownText, verification), claimState);
  assistantMessage.content = finalText;
  let followupsAdded = [];
  if (!options.isSubagent && !options.planOnly && followupsEnabled(session, options.env || process.env)) {
    try { followupsAdded = await recordFollowups(session.root, extractFollowups(text), { sessionId: session.sessionId || '' }); } catch {}
  }
  if (finalText && options.onText) await emitDisplayText(session, options, finalText);
  pruneHistory(session);
  return { type: 'finish', result: {
    text: finalText,
    toolCalls: totals.toolCalls,
    tokensUsed: totals.tokensUsed,
    tokenBudget: totals.tokenBudget,
    finished: issues.length === 0,
    verificationIncomplete: issues.length > 0,
    verificationIssues: issues,
    verification: verificationSummary(verification),
    budgetExceeded: (totals.budgetTokensUsed ?? totals.tokensUsed) > totals.tokenBudget,
    ...(g.emptyReply ? { emptyReply: true } : {}),
    ...(followupsAdded.length ? { followupsAdded: followupsAdded.map((item) => ({ id: item.id, text: item.text })) } : {})
  } };
}
