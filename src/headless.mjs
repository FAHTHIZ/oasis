// Headless (print) mode for scripts and CI, like `claude -p`.
//   oasis -p "fix the failing test" --output-format json --max-turns 20
// Output formats:
//   text         final answer only (default)
//   json         one JSON object: { type: "result", subtype, result, is_error, ... }
//   stream-json  one JSON event per line: system/init, assistant, tool_use,
//                tool_result, then a final result event
// No terminal is available for approvals, so anything that would need a prompt is
// denied unless a permission rule, permission mode, or --yes allows it.
import { createSession, runAgentTurn, runAgentPlan, closeSession } from './agent.mjs';
import { expandFileMentions } from './commands.mjs';
import { visionEnabled } from './images.mjs';
import { saveSession, loadSession } from './sessions.mjs';
import { validateJsonSchema, extractJson } from './json-schema.mjs';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'];

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
    write = (text) => process.stdout.write(text)
  } = options;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error('--output-format must be one of ' + OUTPUT_FORMATS.join(', ') + '.');
  const started = Date.now();
  const emit = (event) => { if (outputFormat === 'stream-json') write(JSON.stringify(event) + '\n'); };
  const denied = [];
  let session = null;
  let result = null;
  let error = null;
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let requests = 0;
  let structured;
  let schemaErrors = null;
  try {
    let restored = null;
    if (persistence.resumeId) restored = await loadSession(root, persistence.resumeId);
    session = await createSession({ root, config, restore: restored, env, ...sessionOptions });
    emit({ type: 'system', subtype: 'init', session_id: session.sessionId || null, cwd: root, model: config.model, permission_mode: session.permissions.mode, tools: session.toolDefinitions.map((tool) => tool.function.name) });
    const expanded = await expandFileMentions(root, rawPrompt, { images: visionEnabled(config, env) }).catch(() => ({ text: rawPrompt, files: [] }));
    const runner = planOnly ? runAgentPlan : runAgentTurn;
    const schemaInstruction = jsonSchema ? '\n\nWhen you are done, your final message must be only a JSON value that matches this JSON Schema, with no other text and no code fence:\n' + JSON.stringify(jsonSchema) : '';
    const turnOptions = {
      autoApprove,
      ...(expanded.images && expanded.images.length ? { images: expanded.images } : {}),
      env,
      ...(maxTurns ? { maxSteps: maxTurns } : {}),
      approval: async (message, forceInteractive = false, meta = {}) => {
        if (autoApprove && !forceInteractive) return true;
        denied.push({ tool_name: meta && meta.tool || null, detail: String(message).replace(/\s+/g, ' ').trim().slice(0, 300) });
        return false;
      },
      onToolStart: ({ name, args, subagent }) => emit({ type: 'tool_use', name, input: args, ...(subagent ? { subagent } : {}) }),
      onToolResult: ({ name, result: toolResult, subagent }) => emit({ type: 'tool_result', name, is_error: Boolean(toolResult && (toolResult.error || (toolResult.exitCode !== undefined && toolResult.exitCode !== 0))), content: truncateValue(toolResult), ...(subagent ? { subagent } : {}) }),
      onText: (text) => emit({ type: 'assistant', text }),
      onUsage: (step) => {
        usage.input_tokens += Number(step.inputTokens || 0);
        usage.output_tokens += Number(step.outputTokens || 0);
        usage.total_tokens += Number(step.totalTokens || 0);
        if (step.phase === undefined) requests += 1;
      }
    };
    result = await runner(session, expanded.text + schemaInstruction, turnOptions);
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
  if (session) closeSession(session);
  const isError = Boolean(error) || !result || result.blockedByHook === true || Boolean(schemaErrors);
  const subtype = error ? 'error_during_execution' : schemaErrors ? 'error_max_structured_output_retries' : result && result.limitReached ? 'error_max_turns' : result && result.finished === false && !result.verificationIncomplete ? 'error_max_turns' : 'success';
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
    permission_denials: denied,
    ...(structured !== undefined ? { structured_output: structured } : {}),
    ...(schemaErrors ? { structured_output_errors: schemaErrors.slice(0, 20) } : {}),
    ...(result && result.verificationIncomplete ? { verification_issues: result.verificationIssues } : {})
  };
  if (outputFormat === 'text') write(structured !== undefined ? JSON.stringify(structured) + '\n' : summary.result + (summary.result.endsWith('\n') ? '' : '\n'));
  else write(JSON.stringify(summary) + '\n');
  return { exitCode: isError ? 1 : 0, summary };
}
