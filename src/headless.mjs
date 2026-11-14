import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
// Headless (print) mode for scripts and CI, like `claude -p`.
//   oasis -p "fix the failing test" --output-format json --max-turns 20
// Output formats:
//   text         final answer only (default)
//   json         one JSON object: { type: "result", subtype, result, is_error, ... }
//   stream-json  one JSON event per line: system/init, assistant, tool_use,
//                tool_result, then a final result event
// No terminal is available for approvals, so anything that would need a prompt is
// denied unless a permission rule, permission mode, or --yes allows it.
import { activeAgentMonitors, startPluginMonitorsFor } from './monitors.mjs';

const WAKE_KINDS = new Set(['monitor', 'monitor-end', 'background-exit', 'background-stuck', 'agent-notice', 'mcp-task', 'channel']);
const WAKE_PREFIX = '[background event] ';
import { createSession, runAgentTurn, runAgentPlan, closeSession, suggestNextPrompt, steerSession, takeSteering, steeringMessage, formatWait } from './agent.mjs';
import { expandFileMentions } from './commands.mjs';
import { labelToolActivity } from './tool-activity.mjs';
import { visionEnabled } from './images.mjs';
import { saveSession, loadSession, saveMidTurn, settleMidTurnSave, getSessionDirectory } from './sessions.mjs';
import { validateJsonSchema, extractJson } from './json-schema.mjs';
import { callMappedMcpTool } from './mcp.mjs';
import { FALLBACK_REASON_TEXT } from './fallback-chain.mjs';
import { redactSecretText } from './secret-shield.mjs';

// Finds an MCP tool by Claude-style name (mcp__server__tool) or Oasis safe name.
function resolvePermissionTool(session, name) {
  if (!session || !session.mcpToolMap || !name) return null;
  if (session.mcpToolMap.has(name)) return name;
  const match = String(name).match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  for (const [safeName, mapped] of session.mcpToolMap) {
    if (mapped.resourceTool) continue;
    if (match && mapped.serverName === match[1].toLowerCase() && mapped.toolName === match[2]) return safeName;
    if (mapped.toolName === name) return safeName;
  }
  return null;
}

// Parses one line of --input-format stream-json into a prompt string.
export function parseStreamInputLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  let event;
  try { event = JSON.parse(text); } catch { throw new Error('--input-format stream-json: each line must be a JSON object.'); }
  if (!event || event.type !== 'user') return null;
  const content = event.message ? event.message.content : event.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n');
  return null;
}

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json', 'none'];

/**
 * Bidirectional stream-json channel (Claude Code SDK control protocol).
 * Reads stdin lines eagerly so control messages arrive while a turn runs:
 *   {"type":"user","message":{...}}                                  -> next prompt
 *   {"type":"control_response","response":{"request_id":ID,...}}     -> answers a control_request
 *   {"type":"control_request","request_id":ID,"request":{"subtype":"interrupt"}} -> stops the turn
 * request(payload) emits {"type":"control_request",...} through `write` and waits for the answer.
 */
export function createStreamJsonChannel(lines, write) {
  const queue = [];
  const waiters = [];
  const pending = new Map();
  let ended = false;
  let nextId = 1;
  let interruptHandler = null;
  let steerHandler = null;
  const push = (value) => { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else queue.push(value); };
  const handleLine = (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    let event = null;
    try { event = JSON.parse(text); } catch { return; }
    if (event && event.type === 'control_response') {
      const response = event.response || {};
      const id = String(response.request_id ?? event.request_id ?? '');
      const resolve = pending.get(id);
      if (resolve) { pending.delete(id); resolve(response); }
      return;
    }
    if (event && event.type === 'control_request') {
      const subtype = event.request && event.request.subtype;
      if (subtype === 'interrupt' && interruptHandler) interruptHandler();
      write({ type: 'control_response', response: { subtype: subtype === 'interrupt' ? 'success' : 'error', request_id: event.request_id, ...(subtype === 'interrupt' ? {} : { error: 'Unsupported control request: ' + subtype }) } });
      return;
    }
    const prompt = parseStreamInputLine(text);
    if (prompt === null || !prompt.trim()) return;
    // {"type":"user","steer":true,...} while a turn runs: deliver it to the
    // running agent at its next step instead of queuing a new turn.
    if (event && event.steer === true && steerHandler && steerHandler(prompt)) {
      write({ type: 'system', subtype: 'steer_queued' });
      return;
    }
    push(prompt);
  };
  const finish = () => {
    ended = true;
    while (waiters.length) waiters.shift()({ value: undefined, done: true });
    for (const resolve of pending.values()) resolve({ subtype: 'error', error: 'input closed' });
    pending.clear();
  };
  (async () => { try { for await (const line of lines) handleLine(line); } catch {} finish(); })();
  return {
    [Symbol.asyncIterator]() {
      return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise((resolve) => waiters.push(resolve)) };
    },
    unshift(value) { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else queue.unshift(value); },
    onSteer(handler) { steerHandler = typeof handler === 'function' ? handler : null; },
    request(request) {
      if (ended) return Promise.resolve({ subtype: 'error', error: 'input closed' });
      const id = 'oasis-' + (nextId++);
      return new Promise((resolve) => { pending.set(id, resolve); write({ type: 'control_request', request_id: id, request }); });
    },
    onInterrupt(handler) { interruptHandler = handler; },
    /** Queue a synthetic turn (a background event woke the idle session). */
    wake(text) { if (!ended) push({ wake: String(text || '') }); },
    get closed() { return ended; }
  };
}

function truncateValue(value, limit = 4000) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  return text.length > limit ? text.slice(0, limit) + '...[truncated]' : text;
}

export async function runHeadless(options) {
  const {
    prompt: rawPrompt,
    root,
    config,
    outputFormat = 'text',
    maxTurns = null,
    autoApprove = false,
    planOnly = false,
    jsonSchema = null,
    sessionOptions = {},
    persistence = {},
    env = process.env,
    write = (text) => process.stdout.write(text),
    // SDK hooks: onEvent gets every event object, onSession can add tools,
    // canUseTool answers approvals, signal cancels the run.
    onEvent = null,
    onSession = null,
    canUseTool = null,
    signal = null,
    inputStream = null,
    includePartial = false,
    replayUser = false,
    permissionPromptTool = null,
    permissionPrompts = null,
    includeHookEvents = false,
    forwardSubagentText = false,
    promptSuggestions = false,
    // Goal mode (oasis -p --goal "..."): after each turn a strict side check
    // asks whether the condition is met; if not, the run continues with the
    // reviewer's reason, up to goalMaxTurns turns. Same loop as /goal.
    goal = null,
    goalMaxTurns = 10,
    // --require-verified (or OASIS_REQUIRE_VERIFIED=1): a run whose changes OASIS could
    // not verify (no passing check, unreviewed diff, failing test) exits 1 with
    // subtype error_not_verified, so CI and scripts don't treat "Not verified" as success.
    requireVerified = false,
    // Text mode: one short line per step on stderr, so `oasis -p` is not
    // silent for minutes. On by default only when stderr is a terminal;
    // OASIS_PROGRESS=1 forces it on, OASIS_PROGRESS=0 turns it off.
    progressWrite = null,
    // Raw tool callbacks ({ name, args, call, subagent } / { name, result, call, subagent }),
    // used by `oasis exec --json` to build Codex exec items from untruncated results.
    toolObserver = null,
    // Extra images for the first prompt (Codex exec --image), [{ mediaType, data, name }].
    images: extraImages = []
  } = options;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error('--output-format must be one of ' + OUTPUT_FORMATS.join(', ') + '.');
  const started = Date.now();
  const emit = (event) => {
    if (onEvent) onEvent(event);
    if (outputFormat === 'stream-json') write(JSON.stringify(event) + '\n');
  };
  const progressOn = outputFormat === 'text' && (progressWrite || env.OASIS_PROGRESS === '1' || (env.OASIS_PROGRESS !== '0' && process.stderr.isTTY));
  const progress = !progressOn ? null : progressWrite || ((line) => process.stderr.write(process.stderr.isTTY ? '\x1b[2m' + line + '\x1b[22m\n' : line + '\n'));
  const progressLine = (name, args) => {
    const label = labelToolActivity(name, args || {});
    const command = /^(run_command|run_shell|powershell)$/.test(name) && args ? [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ') : '';
    return '  · ' + label + (command && !label.includes(command) ? ': ' + command.replace(/\s+/g, ' ').slice(0, 100) : '');
  };
  const denied = [];
  let session = null;
  let toolCallsAtStart = 0;
  let result = null;
  let error = null;
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let costUsd = 0;
  // False once any request went to a model with no known price (a gateway's
  // routed model, an unlisted custom model): total_cost_usd then counts only
  // the priced requests and is not evidence that the run was free.
  let costKnown = true;
  let requests = 0;
  let structured;
  let schemaErrors = null;
  let goalState = null;
  try {
    let restored = null;
    if (persistence.resumeId) restored = await loadSession(root, persistence.resumeId);
    if (restored && persistence.fork) restored = { ...restored, id: null };
    const hookObserver = outputFormat === 'stream-json' || onEvent ? (event) => { if (includeHookEvents || ['SessionStart', 'Setup'].includes(event.hook_event)) emit({ type: 'system', ...event, session_id: session && session.sessionId || null }); } : null;
    session = await createSession({ root, config, restore: restored, env, ...sessionOptions, ...(hookObserver ? { onHookEvent: hookObserver } : {}) });
    session.headless = true;
    toolCallsAtStart = Number(session.toolCallsThisSession || 0);
    // Name a saved run up front, as Claude Code does: the init event and every
    // later event then carry the id a client needs for --resume, instead of
    // null until the end-of-run save.
    if (persistence.enabled && !session.sessionId) session.sessionId = randomUUID();
    // Text mode only: stream-json consumers get exactly the events they expect.
    if (outputFormat === 'text' && env.OASIS_PROGRESS !== '0') for (const note of session.localContextNotices || []) { try { process.stderr.write('[local model] ' + note + '\n'); } catch {} }
    // Hook lifecycle events: SessionStart/Setup always (Claude Code), the rest with --include-hook-events.
    if (onSession) await onSession(session);
    // Launched by the IDE (chat panel or an integrated terminal): connect to its bridge.
    if (env.OASIS_IDE_PORT && !session.ide) {
      try {
        const { discoverIde, attachIde } = await import('./ide.mjs');
        const client = await discoverIde(root, env);
        if (client) attachIde(session, client);
      } catch {}
    }
    emit({ type: 'system', subtype: 'init', session_id: session.sessionId || null, cwd: root, model: config.model, permission_mode: session.permissions.mode, tools: session.toolDefinitions.map((tool) => tool.function.name) });
    const expanded = await expandFileMentions(root, rawPrompt, { images: visionEnabled(config, env) }).catch(() => ({ text: rawPrompt, files: [] }));
    if (Array.isArray(extraImages) && extraImages.length) expanded.images = [...(expanded.images || []), ...extraImages];
    const runner = planOnly ? runAgentPlan : runAgentTurn;
    const schemaInstruction = jsonSchema ? '\n\nWhen you are done, your final message must be only a JSON value that matches this JSON Schema, with no other text and no code fence:\n' + JSON.stringify(jsonSchema) : '';
    const turnOptions = {
      autoApprove,
      ...(expanded.images && expanded.images.length ? { images: expanded.images } : {}),
      env,
      ...(maxTurns ? { maxSteps: maxTurns } : {}),
      ...(signal ? { signal } : {}),
      approval: async (message, forceInteractive = false, meta = {}) => {
        if (autoApprove && !forceInteractive) return true;
        // --permission-prompts none: never ask anyone; anything not pre-approved is denied.
        if (permissionPrompts === 'none') { denied.push({ tool_name: meta && meta.tool || null, detail: String(message).replace(/\s+/g, ' ').trim().slice(0, 300) }); return false; }
        if (permissionPromptTool === 'stdio' && session && session.ide && meta && meta.tool) {
          // Edits open in the IDE's native diff view; Accept/Reject there answers the approval.
          const { reviewEditInIde } = await import('./ide.mjs');
          const reviewed = await reviewEditInIde(session, meta);
          if (reviewed !== null) {
            emit({ type: 'system', subtype: 'permission', tool: meta.tool, allowed: reviewed, via: 'ide_diff' });
            if (!reviewed) denied.push({ tool_name: meta.tool, detail: 'Rejected in the IDE diff view.' });
            return reviewed;
          }
        }
        if (permissionPromptTool === 'stdio' && inputStream && typeof inputStream.request === 'function') {
          const reply = await inputStream.request({ subtype: 'can_use_tool', tool_name: meta && meta.tool || null, input: meta && meta.input || {}, message: String(message), ...(meta && meta.suggestion ? { permission_suggestions: [meta.suggestion] } : {}) });
          const answer = reply && reply.response && typeof reply.response === 'object' ? reply.response : reply || {};
          const allowed = answer.behavior === 'allow';
          emit({ type: 'system', subtype: 'permission', tool: meta && meta.tool || null, allowed, via: 'stdio' });
          if (allowed) return answer.always && meta && meta.suggestion ? 'always' : true;
          denied.push({ tool_name: meta && meta.tool || null, detail: String(answer.message || message).replace(/\s+/g, ' ').trim().slice(0, 300) });
          return false;
        }
        if (permissionPromptTool && permissionPromptTool !== 'stdio') {
          const tool = resolvePermissionTool(session, permissionPromptTool);
          if (tool) {
            try {
              const reply = await callMappedMcpTool(session, tool, { tool_name: meta && meta.tool || null, input: meta && meta.input || {}, message: String(message) });
              const text = typeof reply === 'string' ? reply : Array.isArray(reply && reply.content) ? reply.content.map((block) => block.text || '').join('') : JSON.stringify(reply);
              const decision = extractJson(text);
              const allowed = decision.ok && decision.value && decision.value.behavior === 'allow';
              emit({ type: 'system', subtype: 'permission', tool: meta && meta.tool || null, allowed, via: permissionPromptTool });
              if (allowed) return true;
            } catch (caught) { emit({ type: 'system', subtype: 'permission_tool_error', error: String(caught.message || caught).slice(0, 300) }); }
          } else emit({ type: 'system', subtype: 'permission_tool_error', error: 'permission prompt tool ' + permissionPromptTool + ' was not found among connected MCP tools' });
        }
        if (canUseTool) {
          const answer = await canUseTool(meta && meta.tool || null, meta && meta.input || {}, { message: String(message), suggestion: meta && meta.suggestion || null });
          const allowed = answer === true || (answer && answer.behavior === 'allow');
          emit({ type: 'system', subtype: 'permission', tool: meta && meta.tool || null, allowed });
          if (allowed) return true;
        }
        // A detached background run (oasis --bg) waits for `oasis bg approve|deny ID`.
        if (!canUseTool && !permissionPromptTool && env.OASIS_BACKGROUND_ID && env.OASIS_BACKGROUND_APPROVALS !== '0') {
          const { requestBackgroundApproval } = await import('./background-sessions.mjs');
          const timeoutMs = Number(env.OASIS_BACKGROUND_APPROVAL_TIMEOUT_MS) || Number(session && session.settings && session.settings.backgroundApprovalTimeoutMinutes) * 60000 || undefined;
          const answer = await requestBackgroundApproval(env.OASIS_BACKGROUND_ID, { tool: meta && meta.tool || null, message: String(message), canAlways: Boolean(meta && meta.suggestion) }, env, {
            timeoutMs,
            signal,
            onRequest: (pending) => emit({ type: 'system', subtype: 'permission_request', tool: pending.tool, message: pending.message, expires_at: pending.expiresAt }),
          }).catch(() => 'deny');
          const allowed = answer === 'allow' || answer === 'always';
          emit({ type: 'system', subtype: 'permission', tool: meta && meta.tool || null, allowed, via: 'background', ...(answer === 'timeout' ? { timed_out: true } : {}) });
          if (allowed) return answer === 'always' ? 'always' : true;
          denied.push({ tool_name: meta && meta.tool || null, detail: (answer === 'timeout' ? 'No answer before the approval timeout. ' : 'Denied with oasis bg deny. ') + String(message).replace(/\s+/g, ' ').trim().slice(0, 260) });
          return false;
        }
        denied.push({ tool_name: meta && meta.tool || null, ...(meta && meta.input && typeof meta.input === 'object' ? { tool_input: meta.input } : {}), detail: String(message).replace(/\s+/g, ' ').trim().slice(0, 300) });
        return false;
      },
      onToolStart: ({ name, args, subagent, call }) => (toolObserver && toolObserver.start && toolObserver.start({ name, args, subagent, call }), progress && !subagent && progress(progressLine(name, args)), emit({ type: 'tool_use', ...(call && call.id ? { id: call.id } : {}), name, input: args, ...(subagent ? { subagent } : {}) })),
      ...(forwardSubagentText || env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT === '1' || env.OASIS_FORWARD_SUBAGENT_TEXT === '1' ? { onSubagentText: ({ text, subagent, agentId, parentToolUseId }) => emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: parentToolUseId, subagent, agent_id: agentId, session_id: session.sessionId || null }) } : {}),
      onToolResult: ({ name, result: toolResult, subagent, call }) => { if (persistence.enabled) saveMidTurn(session, { env }); if (toolObserver && toolObserver.result) toolObserver.result({ name, result: toolResult, subagent, call }); emit({ type: 'tool_result', ...(call && call.id ? { tool_use_id: call.id } : {}), name, is_error: Boolean(toolResult && (toolResult.error || (toolResult.exitCode !== undefined && toolResult.exitCode !== 0))), content: truncateValue(toolResult), ...(subagent ? { subagent } : {}) }) },
      onText: (text) => emit({ type: 'assistant', text }),
      // Text and JSON output print only the final reply, so earlier replies in
      // the turn were not seen and the final answer has to stand on its own.
      textShown: outputFormat === 'stream-json',
      onAutoMode: ({ tool, decision, reason }) => emit({ type: 'system', subtype: 'auto_mode', tool, decision, reason }),
      // Notice on stderr in every output format, so text results on stdout stay clean.
      onProviderRetry: ({ status, attempt, limit, waitMs, reason }) => { process.stderr.write('[retry] Provider ' + (status ? 'error ' + status : 'connection failed') + (reason && status ? ' (' + reason + ')' : '') + '; retrying in ' + formatWait(waitMs) + ' (' + attempt + '/' + limit + ').\n'); emit({ type: 'system', subtype: 'api_retry', attempt, max_retries: limit, retry_delay_ms: waitMs, error_status: status || null }); },
      // Seen live: `oasis -p --model typo` answered from the saved backup model
      // with no word about it outside the JSON summary.
      onFallback: ({ from, to, kind, provider, reason }) => { process.stderr.write('[fallback] ' + from + ' ' + (FALLBACK_REASON_TEXT[kind] || 'failed') + (reason ? ' (' + redactSecretText(String(reason)).slice(0, 120) + ')' : '') + '; switched to ' + (provider ? provider + ':' : '') + to + '.\n'); emit({ type: 'system', subtype: 'model_fallback', from, to, ...(provider ? { provider } : {}), reason: kind || null }); },
      onRateLimitWait: ({ waitMs, until, attempt, compactTools }) => { process.stderr.write('[rate limit] Waiting ' + formatWait(waitMs) + ' for the provider rate limit (attempt ' + attempt + ', until ' + new Date(until).toTimeString().slice(0, 8) + ').' + (compactTools ? ' Switched to the compact tool set to fit its per-minute token limit; other tools stay available through tool_search.' : '') + '\n'); emit({ type: 'system', subtype: 'rate_limit_wait', wait_ms: waitMs, until, attempt, ...(compactTools ? { compact_tools: true } : {}) }); },
      // Stream even when nothing is shown, so a stalled provider hits the
      // header timeout and the stream idle watchdog instead of the 600 s request timeout.
      ...(includePartial && outputFormat === 'stream-json' ? { onDelta: (accumulated) => {
        const text = String(accumulated || '');
        const delta = text.startsWith(partialSoFar) ? text.slice(partialSoFar.length) : text;
        partialSoFar = text;
        if (delta) emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } });
      } } : env.OASIS_NO_STREAM !== '1' ? { onDelta: () => {} } : {}),
      ...(outputFormat === 'stream-json' ? { onStreamRestart: (info) => {
        partialSoFar = '';
        emit({ type: 'system', subtype: 'stream_restarted', attempt: info.attempt, reason: info.reason, ...(info.kind ? { kind: info.kind } : {}) });
      } } : {}),
      onUsage: (step) => {
        costUsd += Number(step.costUsd || 0);
        if (step.costKnown === false) costKnown = false;
        usage.input_tokens += Number(step.inputTokens || 0);
        usage.output_tokens += Number(step.outputTokens || 0);
        usage.total_tokens += Number(step.totalTokens || 0);
        if (step.cacheReadTokens) usage.cache_read_input_tokens = (usage.cache_read_input_tokens || 0) + Number(step.cacheReadTokens);
        if (step.cacheCreationTokens) usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens || 0) + Number(step.cacheCreationTokens);
        if (step.phase === undefined) requests += 1;
      }
    };
    // Background agents report here, also after the turn that started them.
    session.onBackgroundUsage = turnOptions.onUsage;
    let partialSoFar = '';
    let currentTurn = null;
    if (inputStream && typeof inputStream.onInterrupt === 'function') inputStream.onInterrupt(() => { if (currentTurn) currentTurn.abort(); });
    const runOneTurn = async (text) => {
      partialSoFar = '';
      if (inputStream && typeof inputStream.onInterrupt === 'function') {
        currentTurn = new AbortController();
        if (signal) signal.addEventListener('abort', () => currentTurn && currentTurn.abort(), { once: true });
        const turnSignal = currentTurn.signal;
        if (replayUser && !text.startsWith(WAKE_PREFIX)) emit({ type: 'user', message: { role: 'user', content: text } });
        let prepared = text === rawPrompt ? expanded : await expandFileMentions(root, text, { images: visionEnabled(config, env) }).catch(() => ({ text, files: [] }));
        if (session.ide) {
          try {
            const { ideSelectionContext } = await import('./ide.mjs');
            const selection = await ideSelectionContext(session);
            if (selection) { emit({ type: 'system', subtype: 'ide_selection', label: selection.label }); prepared = { ...prepared, text: selection.text + '\n\n' + prepared.text }; }
          } catch {}
        }
        try {
          return await runner(session, prepared.text + schemaInstruction, { ...turnOptions, signal: turnSignal, ...(prepared.images && prepared.images.length ? { images: prepared.images } : {}) });
        } catch (caught) {
          if (turnSignal.aborted) { emit({ type: 'system', subtype: 'interrupted' }); return { text: '[interrupted]', finished: true, toolCalls: 0, interrupted: true }; }
          throw caught;
        } finally { currentTurn = null; }
      }
      if (replayUser && !text.startsWith(WAKE_PREFIX)) emit({ type: 'user', message: { role: 'user', content: text } });
      const prepared = text === rawPrompt ? expanded : await expandFileMentions(root, text, { images: visionEnabled(config, env) }).catch(() => ({ text, files: [] }));
      return runner(session, prepared.text + schemaInstruction, { ...turnOptions, ...(prepared.images && prepared.images.length ? { images: prepared.images } : {}) });
    };
    // Opt-in auto-commit (OASIS_AUTO_COMMIT=1 or "autoCommit": true) commits each turn's changed files.
    const runOne = async (text) => {
      const turn = await runOneTurn(text);
      const changed = turn && turn.verification && Array.isArray(turn.verification.changedPaths) ? turn.verification.changedPaths : [];
      if (changed.length && !turn.interrupted) {
        const { autoCommitEnabled, autoCommitTurn } = await import('./auto-commit.mjs');
        if (autoCommitEnabled(session, env)) {
          const commit = await autoCommitTurn({ root: session.root || root, paths: changed, prompt: text }).catch((error) => ({ error: error.message }));
          if (commit.committed || commit.error) emit({ type: 'system', subtype: 'auto_commit', ...(commit.committed ? { commit: commit.committed, message: commit.subject, files: commit.files } : { error: commit.error }) });
        }
      }
      return turn;
    };
    if (inputStream) {
      // --input-format stream-json: each user message is one turn in the same session.
      let turns = 0;
      if (String(rawPrompt || '').trim()) { result = await runOne(rawPrompt); turns += 1; emit({ type: 'result', subtype: 'turn', result: String(result.text || ''), num_turns: turns }); }
      // Monitors, channels, background commands and background agents wake an idle
      // session: their events queue a synthetic turn, like the interactive CLI.
      let busy = false;
      if (typeof inputStream.onSteer === 'function') inputStream.onSteer((text) => busy && steerSession(session, text));
      let wakeQueued = false;
      let wakeTimer = null;
      const pendingWake = () => (session.inbox || []).filter((entry) => WAKE_KINDS.has(entry.kind));
      const scheduleWake = () => {
        if (typeof inputStream.wake !== 'function' || wakeTimer || wakeQueued || busy) return;
        wakeTimer = setTimeout(() => {
          wakeTimer = null;
          if (busy || wakeQueued || !pendingWake().length) return;
          wakeQueued = true;
          inputStream.wake();
        }, 300);
        wakeTimer.unref?.();
      };
      session.onBackgroundEvent = (event) => {
        const last = session.inbox && session.inbox[session.inbox.length - 1];
        if (last && event) last.label = event.description || (event.kind === 'background-exit' ? 'background command ' + event.id + ' finished' : event.id);
        scheduleWake();
      };
      if (env.OASIS_DISABLE_PLUGIN_MONITORS !== '1' && typeof inputStream.wake === 'function') {
        session.pluginMonitorsEnabled = true;
        const started = startPluginMonitorsFor(session, 'always', { root, env });
        if (started.length) emit({ type: 'system', subtype: 'plugin_monitors', started: started.length });
      }
      for await (const item of inputStream) {
        if (item === null || item === undefined) continue;
        let text = item;
        if (typeof item === 'object' && 'wake' in item) {
          wakeQueued = false;
          const events = pendingWake();
          if (!events.length) continue;
          const labels = [...new Set(events.map((entry) => entry.label).filter(Boolean))];
          emit({ type: 'system', subtype: 'background_event', events: events.length, kinds: [...new Set(events.map((entry) => entry.kind))], ids: [...new Set(events.map((entry) => entry.id).filter(Boolean))] });
          text = WAKE_PREFIX + (labels.join(', ') || events.length + ' new event(s)').slice(0, 160);
        }
        busy = true;
        try { result = await runOne(String(text)); } finally {
          busy = false;
          // Steering that missed the turn runs next, in order.
          for (const late of takeSteering(session).reverse()) inputStream.unshift?.(late);
        }
        turns += 1;
        emit({ type: 'result', subtype: 'turn', result: String(result.text || ''), num_turns: turns, total_cost_usd: Number(costUsd.toFixed(6)) });
        if (pendingWake().length) scheduleWake();
      }
      if (wakeTimer) clearTimeout(wakeTimer);
      session.onBackgroundEvent = null;
      if (!result) result = { text: '', finished: true, toolCalls: 0 };
    } else {
      // A detached background run (oasis --bg) takes messages from
      // `oasis bg send ID "..."` through its inbox file and steers mid-turn.
      let stopInbox = null;
      const lateMessages = [];
      const backgroundId = env.OASIS_BACKGROUND_ID;
      if (backgroundId) {
        const { watchInbox } = await import('./background-sessions.mjs');
        stopInbox = watchInbox(backgroundId, (text) => {
          emit({ type: 'system', subtype: 'steer_received', text: text.slice(0, 500) });
          if (!steerSession(session, text)) lateMessages.push(text);
        }, env);
      }
      try {
      result = await runOne(rawPrompt);
      // Monitors the agent started keep the run open (up to their headless deadline);
      // each batch of events becomes a follow-up turn.
      while (!(signal && signal.aborted) && result && !result.limitReached) {
        const isEvent = (entry) => entry.kind === 'monitor' || entry.kind === 'monitor-end';
        if (!(session.inbox || []).some(isEvent)) {
          if (!activeAgentMonitors(session).length) break;
          await new Promise((resolve) => {
            const done = () => { session.onBackgroundEvent = null; if (signal) signal.removeEventListener('abort', done); resolve(); };
            session.onBackgroundEvent = () => setTimeout(done, 300);
            if (signal) signal.addEventListener('abort', done, { once: true });
          });
          continue;
        }
        const events = session.inbox.filter(isEvent);
        emit({ type: 'system', subtype: 'monitor_event', events: events.length, ids: [...new Set(events.map((entry) => entry.id).filter(Boolean))] });
        result = await runOne('[background event] ' + events.length + ' new monitor event(s).');
      }
      // Messages that arrived after the last step (or while the model was
      // finishing) become another turn, so a sent message is never dropped.
      while (backgroundId && !(signal && signal.aborted) && result && !result.limitReached) {
        const { drainInbox } = await import('./background-sessions.mjs');
        const drained = await drainInbox(backgroundId, env).catch(() => []);
        for (const text of drained) emit({ type: 'system', subtype: 'steer_received', text: text.slice(0, 500) });
        const late = [...lateMessages.splice(0), ...takeSteering(session), ...drained];
        if (!late.length) break;
        result = await runOne(steeringMessage(late));
      }
      } finally { if (stopInbox) stopInbox(); }
    }
    if (goal && session && result && !inputStream) {
      const { evaluateGoal } = await import('./agent.mjs');
      goalState = { condition: String(goal), met: false, turns: 1, reason: '' };
      while (!(signal && signal.aborted) && result && !result.limitReached) {
        const verdict = await evaluateGoal(session, goalState.condition).catch((caught) => ({ met: false, reason: 'Check failed: ' + (caught.message || caught) }));
        goalState.met = verdict.met;
        goalState.reason = verdict.reason;
        emit({ type: 'system', subtype: 'goal_check', met: verdict.met, reason: String(verdict.reason || '').slice(0, 500), turn: goalState.turns });
        if (outputFormat === 'text' && env.OASIS_PROGRESS !== '0') { try { process.stderr.write('[goal] ' + (verdict.met ? 'Met' : 'Not met yet') + ': ' + verdict.reason + '\n'); } catch {} }
        if (verdict.met || goalState.turns >= goalMaxTurns) break;
        goalState.turns += 1;
        result = await runOne('The goal is not met yet. A reviewer said: ' + verdict.reason + '\nContinue working toward the goal: ' + goalState.condition + '\nVerify results by running checks, not by assumption.');
      }
    }
    // Structured output: validate, and give the model two chances to fix it.
    for (let attempt = 0; jsonSchema && result && !result.limitReached; attempt += 1) {
      const parsed = extractJson(result.text);
      schemaErrors = parsed.ok ? validateJsonSchema(jsonSchema, parsed.value) : ['the reply is not valid JSON'];
      if (!schemaErrors.length) { structured = parsed.value; schemaErrors = null; break; }
      if (attempt >= 2) break;
      emit({ type: 'system', subtype: 'structured_output_retry', errors: schemaErrors.slice(0, 10) });
      result = await runAgentTurn(session, 'Your final answer did not match the required JSON Schema:\n- ' + schemaErrors.slice(0, 10).join('\n- ') + '\nReply again with only the corrected JSON value.', turnOptions);
    }
  } catch (caught) {
    error = caught;
  }
  let sessionId = session && session.sessionId || null;
  // A run stopped part-way (timeout, SIGTERM, provider failure) keeps what it did:
  // once the model has answered at least once, the session is saved so
  // `oasis --resume ID` continues it instead of starting over.
  const progressed = Boolean(session && Array.isArray(session.messages) && session.messages.some((message) => message && message.role === 'assistant'));
  let savedAfterError = false;
  if (session) await settleMidTurnSave(session);
  let saved = Boolean(persistence.resumeId && !persistence.fork);
  if (session && persistence.enabled && (!error || progressed)) {
    try { sessionId = (await saveSession(session, { env })).id; savedAfterError = Boolean(error); saved = true; } catch {}
  }
  // The id named in init is only resumable once something was saved under it.
  if (!saved && sessionId && !existsSync(path.join(getSessionDirectory(root, env), sessionId + '.json'))) sessionId = null;
  let suggestion = '';
  if (session && promptSuggestions && !error && result && (outputFormat === 'stream-json' || onEvent)) suggestion = await suggestNextPrompt(session, { signal });
  // The budget ledger also holds subagent, review and side-request spend.
  if (session && session.budgetLedger && Number(session.budgetLedger.spentUsd) > costUsd) costUsd = Number(session.budgetLedger.spentUsd);
  if (session) closeSession(session);
  const mustVerify = requireVerified || env.OASIS_REQUIRE_VERIFIED === '1';
  const notVerified = mustVerify && !error && Boolean(result && result.verificationIncomplete);
  const isError = Boolean(error) || !result || result.blockedByHook === true || Boolean(schemaErrors) || Boolean(goalState && !goalState.met) || notVerified;
  const subtype = error && error.code === 'BUDGET_EXCEEDED' ? 'error_max_budget_usd' : error && error.code === 'REQUEST_BUDGET_EXCEEDED' ? 'error_max_requests' : error && error.code === 'TOKEN_BUDGET_EXCEEDED' ? 'error_max_total_tokens' : error && error.code === 'OASIS_ZERO_BUDGET_BLOCKED' ? 'error_zero_budget' : error ? 'error_during_execution' : schemaErrors ? 'error_max_structured_output_retries' : goalState && !goalState.met ? 'error_goal_not_met' : notVerified ? 'error_not_verified' : result && result.limitReached ? 'error_max_turns' : result && result.finished === false && !result.verificationIncomplete ? 'error_max_turns' : 'success';
  const summary = {
    type: 'result',
    subtype,
    is_error: isError,
    result: error ? (signal && signal.aborted && signal.reason && signal.reason.stopSignal ? signal.reason.message : String(error.message || error)) : String(result.text || ''),
    session_id: sessionId,
    num_turns: requests,
    duration_ms: Date.now() - started,
    // The session counter covers every turn of this run (goal, steering and
    // schema-retry turns) and still counts when an error or SIGINT stopped it.
    tool_calls: Math.max(result ? Number(result.toolCalls || 0) : 0, session ? Number(session.toolCallsThisSession || 0) - toolCallsAtStart : 0),
    usage,
    total_cost_usd: Number(costUsd.toFixed(6)),
    ...(costKnown ? {} : { cost_known: false }),
    ...(session && session.fallbackActive ? { fallback_model: session.fallbackActive.to } : {}),
    permission_denials: denied,
    ...(structured !== undefined ? { structured_output: structured } : {}),
    ...(goalState ? { goal: goalState } : {}),
    ...(schemaErrors ? { structured_output_errors: schemaErrors.slice(0, 20) } : {}),
    ...(result && result.verification ? { verification: result.verification } : {}),
    ...(result && result.verificationIncomplete ? { verification_issues: result.verificationIssues } : {}),
    ...(session && Array.isArray(session.reportedFindings) ? { findings: session.reportedFindings, ...(session.findingsSummary ? { findings_summary: session.findingsSummary } : {}) } : {})
  };
  if (outputFormat === 'none') {}
  else if (outputFormat === 'text') write(structured !== undefined ? JSON.stringify(structured) + '\n' : summary.result + (summary.result.endsWith('\n') ? '' : '\n'));
  else if (outputFormat !== 'none') write(JSON.stringify(summary) + '\n');
  // Nobody can approve anything in -p, so say what was skipped and how to allow it next time.
  if (outputFormat === 'text' && denied.length && env.OASIS_PROGRESS !== '0') {
    try { process.stderr.write(deniedHint(denied, { env })); } catch {}
  }
  if (outputFormat === 'text' && notVerified && env.OASIS_PROGRESS !== '0') {
    try { process.stderr.write('\n[oasis] Exiting 1: --require-verified is on and OASIS could not verify these changes.\n'); } catch {}
  }
  if (outputFormat === 'text' && savedAfterError && sessionId && env.OASIS_PROGRESS !== '0') {
    try { process.stderr.write('\nThe work so far is saved. Continue it with: oasis --resume ' + sessionId + '\n'); } catch {}
  }
  if (onEvent) onEvent(summary);
  if (suggestion) emit({ type: 'prompt_suggestion', suggestion, session_id: sessionId });
  return { exitCode: isError ? 1 : 0, summary };
}

// Errors raised before the headless run starts (no provider, bad usage, unreadable
// stdin) must still honor --output-format: scripts that parse JSON get one
// result object on stdout, and the human message goes to stderr, not stdout.
export function headlessSetupErrorOutput(error, outputFormat) {
  const message = String(error && error.message || error);
  const stderrText = 'OASIS error: ' + message + '\n';
  if (outputFormat !== 'json' && outputFormat !== 'stream-json') return { stdout: '', stderr: stderrText };
  const result = { type: 'result', subtype: 'error_during_execution', is_error: true, result: message, session_id: null, num_turns: 0, duration_ms: 0, tool_calls: 0, total_cost_usd: 0, permission_denials: [] };
  return { stdout: JSON.stringify(result) + '\n', stderr: stderrText };
}

/** One stderr paragraph for `oasis -p` naming what was not approved and the flag that allows it. */
export function deniedHint(denied, { env = process.env } = {}) {
  const commands = [];
  const tools = [];
  let highRisk = false;
  for (const item of denied || []) {
    const input = item && item.tool_input;
    if (input && typeof input.command === 'string' && (item.tool_name === 'run_command' || item.tool_name === 'run_shell')) {
      const line = [input.command].concat(Array.isArray(input.args) ? input.args : []).join(' ').trim();
      if (line && !commands.includes(line)) commands.push(line);
      if (/HIGH RISK:/.test(String(item.detail || ''))) highRisk = true;
    } else if (item && item.tool_name && !tools.includes(item.tool_name)) tools.push(item.tool_name);
  }
  if (!commands.length && !tools.length) return '';
  const rules = commands.slice(0, 3).map((line) => 'run_command(' + line.split(/\s+/).slice(0, 2).join(' ') + ':*)');
  const head = '\nNot approved in this run (nobody can approve in -p mode): ' + [...commands.map((line) => '`' + line + '`'), ...tools].slice(0, 6).join(', ') + '.\n';
  if (!rules.length) return head + 'To allow next time: --allowedTools, --yes or --permission-mode auto.\n';
  // Inline code, wrappers and the like ask even with --full-auto or --yes; only an allow rule lets them run.
  if (highRisk) return head + 'High-risk commands (inline code, wrappers and the like) always ask, even with --full-auto. To allow next time: --allowedTools "' + rules.join(',') + '".\n';
  // --full-auto sets OASIS_SANDBOX=1; suggesting it again would not help.
  const sandboxed = String(env.OASIS_SANDBOX || '') === '1';
  return head + 'To allow next time: ' + (sandboxed ? '' : '--full-auto (edits plus commands inside the OS sandbox), ') + '--allowedTools "' + rules.join(',') + '", or --permission-mode auto.\n';
}
