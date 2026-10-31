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

const WAKE_KINDS = new Set(['monitor', 'monitor-end', 'background-exit', 'agent-notice', 'channel']);
const WAKE_PREFIX = '[background event] ';
import { createSession, runAgentTurn, runAgentPlan, closeSession, suggestNextPrompt } from './agent.mjs';
import { expandFileMentions } from './commands.mjs';
import { visionEnabled } from './images.mjs';
import { saveSession, loadSession } from './sessions.mjs';
import { validateJsonSchema, extractJson } from './json-schema.mjs';
import { callMappedMcpTool } from './mcp.mjs';

// Finds an MCP tool by Claude-style name (mcp__server__tool) or Oasis safe name.
export function resolvePermissionTool(session, name) {
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
    if (prompt !== null && prompt.trim()) push(prompt);
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
    promptSuggestions = false
  } = options;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error('--output-format must be one of ' + OUTPUT_FORMATS.join(', ') + '.');
  const started = Date.now();
  const emit = (event) => {
    if (onEvent) onEvent(event);
    if (outputFormat === 'stream-json') write(JSON.stringify(event) + '\n');
  };
  const denied = [];
  let session = null;
  let result = null;
  let error = null;
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let costUsd = 0;
  let requests = 0;
  let structured;
  let schemaErrors = null;
  try {
    let restored = null;
    if (persistence.resumeId) restored = await loadSession(root, persistence.resumeId);
    if (restored && persistence.fork) restored = { ...restored, id: null };
    const hookObserver = outputFormat === 'stream-json' || onEvent ? (event) => { if (includeHookEvents || ['SessionStart', 'Setup'].includes(event.hook_event)) emit({ type: 'system', ...event, session_id: session && session.sessionId || null }); } : null;
    session = await createSession({ root, config, restore: restored, env, ...sessionOptions, ...(hookObserver ? { onHookEvent: hookObserver } : {}) });
    session.headless = true;
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
        denied.push({ tool_name: meta && meta.tool || null, detail: String(message).replace(/\s+/g, ' ').trim().slice(0, 300) });
        return false;
      },
      onToolStart: ({ name, args, subagent, call }) => emit({ type: 'tool_use', ...(call && call.id ? { id: call.id } : {}), name, input: args, ...(subagent ? { subagent } : {}) }),
      ...(forwardSubagentText || env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT === '1' || env.OASIS_FORWARD_SUBAGENT_TEXT === '1' ? { onSubagentText: ({ text, subagent, agentId, parentToolUseId }) => emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: parentToolUseId, subagent, agent_id: agentId, session_id: session.sessionId || null }) } : {}),
      onToolResult: ({ name, result: toolResult, subagent }) => emit({ type: 'tool_result', name, is_error: Boolean(toolResult && (toolResult.error || (toolResult.exitCode !== undefined && toolResult.exitCode !== 0))), content: truncateValue(toolResult), ...(subagent ? { subagent } : {}) }),
      onText: (text) => emit({ type: 'assistant', text }),
      onAutoMode: ({ tool, decision, reason }) => emit({ type: 'system', subtype: 'auto_mode', tool, decision, reason }),
      ...(includePartial && outputFormat === 'stream-json' ? { onDelta: (accumulated) => {
        const text = String(accumulated || '');
        const delta = text.startsWith(partialSoFar) ? text.slice(partialSoFar.length) : text;
        partialSoFar = text;
        if (delta) emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } });
      } } : {}),
      onUsage: (step) => {
        costUsd += Number(step.costUsd || 0);
        usage.input_tokens += Number(step.inputTokens || 0);
        usage.output_tokens += Number(step.outputTokens || 0);
        usage.total_tokens += Number(step.totalTokens || 0);
        if (step.phase === undefined) requests += 1;
      }
    };
    let partialSoFar = '';
    let currentTurn = null;
    if (inputStream && typeof inputStream.onInterrupt === 'function') inputStream.onInterrupt(() => { if (currentTurn) currentTurn.abort(); });
    const runOne = async (text) => {
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
    if (inputStream) {
      // --input-format stream-json: each user message is one turn in the same session.
      let turns = 0;
      if (String(rawPrompt || '').trim()) { result = await runOne(rawPrompt); turns += 1; emit({ type: 'result', subtype: 'turn', result: String(result.text || ''), num_turns: turns }); }
      // Monitors, channels, background commands and background agents wake an idle
      // session: their events queue a synthetic turn, like the interactive CLI.
      let busy = false;
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
        try { result = await runOne(String(text)); } finally { busy = false; }
        turns += 1;
        emit({ type: 'result', subtype: 'turn', result: String(result.text || ''), num_turns: turns, total_cost_usd: Number(costUsd.toFixed(6)) });
        if (pendingWake().length) scheduleWake();
      }
      if (wakeTimer) clearTimeout(wakeTimer);
      session.onBackgroundEvent = null;
      if (!result) result = { text: '', finished: true, toolCalls: 0 };
    } else {
      result = await runOne(rawPrompt);
      // Monitors the agent started keep the run open (up to their headless deadline);
      // each batch of events becomes a follow-up turn.
      while (!(signal && signal.aborted) && result && !result.limitReached) {
        const isEvent = (entry) => entry.kind === 'monitor' || entry.kind === 'monitor-end';
        if (!(session.inbox || []).some(isEvent)) {
          if (!activeAgentMonitors(session).length) break;
          await new Promise((resolve) => { session.onBackgroundEvent = () => { session.onBackgroundEvent = null; setTimeout(resolve, 300); }; });
          continue;
        }
        const events = session.inbox.filter(isEvent);
        emit({ type: 'system', subtype: 'monitor_event', events: events.length, ids: [...new Set(events.map((entry) => entry.id).filter(Boolean))] });
        result = await runOne('[background event] ' + events.length + ' new monitor event(s).');
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
  if (session && persistence.enabled && !error) {
    try { sessionId = (await saveSession(session, { env })).id; } catch {}
  }
  let suggestion = '';
  if (session && promptSuggestions && !error && result && (outputFormat === 'stream-json' || onEvent)) suggestion = await suggestNextPrompt(session, { signal });
  if (session) closeSession(session);
  const isError = Boolean(error) || !result || result.blockedByHook === true || Boolean(schemaErrors);
  const subtype = error && error.code === 'BUDGET_EXCEEDED' ? 'error_max_budget_usd' : error ? 'error_during_execution' : schemaErrors ? 'error_max_structured_output_retries' : result && result.limitReached ? 'error_max_turns' : result && result.finished === false && !result.verificationIncomplete ? 'error_max_turns' : 'success';
  const summary = {
    type: 'result',
    subtype,
    is_error: isError,
    result: error ? String(error.message || error) : String(result.text || ''),
    session_id: sessionId,
    num_turns: requests,
    duration_ms: Date.now() - started,
    tool_calls: result ? Number(result.toolCalls || 0) : 0,
    usage,
    total_cost_usd: Number(costUsd.toFixed(6)),
    ...(session && session.fallbackActive ? { fallback_model: session.fallbackActive.to } : {}),
    permission_denials: denied,
    ...(structured !== undefined ? { structured_output: structured } : {}),
    ...(schemaErrors ? { structured_output_errors: schemaErrors.slice(0, 20) } : {}),
    ...(result && result.verification ? { verification: result.verification } : {}),
    ...(result && result.verificationIncomplete ? { verification_issues: result.verificationIssues } : {}),
    ...(session && Array.isArray(session.reportedFindings) ? { findings: session.reportedFindings, ...(session.findingsSummary ? { findings_summary: session.findingsSummary } : {}) } : {})
  };
  if (outputFormat === 'none') {}
  else if (outputFormat === 'text') write(structured !== undefined ? JSON.stringify(structured) + '\n' : summary.result + (summary.result.endsWith('\n') ? '' : '\n'));
  else if (outputFormat !== 'none') write(JSON.stringify(summary) + '\n');
  if (onEvent) onEvent(summary);
  if (suggestion) emit({ type: 'prompt_suggestion', suggestion, session_id: sessionId });
  return { exitCode: isError ? 1 : 0, summary };
}
