// Prompt-based tool calling for endpoints that drop the `tools` field.
//
// Some OpenAI-compatible routes (keyless playgrounds, older vLLM builds, proxies
// that only forward messages) answer chat requests but ignore tool
// definitions, so even a strong model never calls a tool. In prompt mode OASIS
// describes the tools in the system message and the model writes calls as
//
//   <function=read_file>
//   <parameter=path>src/app.js</parameter>
//   </function>
//
// The format follows OpenHands' function-calling converter
// (openhands/sdk/llm/mixins/fn_call_converter.py, MIT), which in turn follows
// LiteLLM. Qwen3-Coder emits the same syntax natively, and the existing text
// tool-call parser (tool-call-repair.mjs) reads it back into native calls, with
// values coerced against each tool's schema. History is rewritten the same way:
// earlier calls become that text, and tool results become user messages that
// start with "EXECUTION RESULT of [name]".
//
// Browser-safe: no Node.js imports, so app/core can share it.

const MAX_DESCRIPTION_CHARS = 1200;
const MAX_PARAM_DESCRIPTION_CHARS = 400;

/** True when this request should describe tools in the prompt instead of sending `tools`. */
export function promptToolCalling(config = {}, env = {}) {
  const forced = String(env && env.OASIS_TOOL_CALLING || '').toLowerCase();
  if (forced === 'native') return false;
  if (forced === 'prompt') return true;
  return config && config.toolCalling === 'prompt';
}

function typeSummary(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.type)) return schema.type.join(' or ');
  if (schema.type === 'array') return 'array of ' + typeSummary(schema.items);
  if (schema.type) return schema.type;
  for (const key of ['anyOf', 'oneOf']) if (Array.isArray(schema[key])) return schema[key].map(typeSummary).join(' or ');
  return 'any';
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+\n/g, '\n').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

/** The tool list in OpenHands' "BEGIN FUNCTION" layout. */
export function describeTools(tools = []) {
  return tools.map((tool, index) => {
    const fn = tool && (tool.function || tool);
    const params = fn.parameters || fn.input_schema || {};
    const properties = params.properties || {};
    const required = new Set(Array.isArray(params.required) ? params.required : []);
    const lines = ['---- BEGIN FUNCTION #' + (index + 1) + ': ' + fn.name + ' ----'];
    if (fn.description) lines.push('Description: ' + clip(fn.description, MAX_DESCRIPTION_CHARS));
    const names = Object.keys(properties);
    if (!names.length) lines.push('No parameters.');
    else {
      lines.push('Parameters:');
      names.forEach((name, at) => {
        const info = properties[name] || {};
        let line = '  (' + (at + 1) + ') ' + name + ' (' + typeSummary(info) + ', ' + (required.has(name) ? 'required' : 'optional') + ')';
        if (info.description) line += ': ' + clip(info.description, MAX_PARAM_DESCRIPTION_CHARS);
        if (Array.isArray(info.enum)) line += ' Allowed values: ' + info.enum.map((value) => '`' + value + '`').join(', ') + '.';
        lines.push(line);
      });
    }
    lines.push('---- END FUNCTION #' + (index + 1) + ' ----');
    return lines.join('\n');
  }).join('\n');
}

/** Instructions appended to the system message. */
export function toolsInstructions(tools = [], { forceTool = '' } = {}) {
  return [
    '',
    'You have access to the following functions:',
    '',
    describeTools(tools),
    '',
    'To call a function, reply in exactly this format:',
    '',
    '<function=example_function_name>',
    '<parameter=example_parameter_1>value_1</parameter>',
    '<parameter=example_parameter_2>',
    'A value that can span',
    'multiple lines',
    '</parameter>',
    '</function>',
    '',
    '<IMPORTANT>',
    '- Calls MUST start with <function= and end with </function>. Required parameters MUST be given.',
    '- Write strings as they are, without quotes. Write numbers, booleans, arrays and objects as JSON.',
    '- You may explain briefly BEFORE a call, never after it. Then stop and wait: the result arrives in the next message as "EXECUTION RESULT of [name]".',
    '- Several independent calls may follow one another in one reply.',
    '- Never write an EXECUTION RESULT yourself. When the task is done, answer normally without a call.',
    ...(forceTool ? ['- Call ' + forceTool + ' now.'] : []),
    '</IMPORTANT>'
  ].join('\n');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part && (part.text || (part.type === 'image_url' ? '[image]' : ''))).filter(Boolean).join('\n');
  return content == null ? '' : String(content);
}

function parameterValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One native call as prompt-format text. */
export function callAsText(call) {
  const fn = call && call.function || {};
  let args = {};
  try { args = typeof fn.arguments === 'string' ? (fn.arguments.trim() ? JSON.parse(fn.arguments) : {}) : (fn.arguments || {}); }
  catch { args = { arguments: String(fn.arguments) }; }
  const lines = ['<function=' + fn.name + '>'];
  for (const [key, value] of Object.entries(args && typeof args === 'object' ? args : {})) {
    const text = parameterValue(value);
    lines.push(text.includes('\n') ? '<parameter=' + key + '>\n' + text + '\n</parameter>' : '<parameter=' + key + '>' + text + '</parameter>');
  }
  lines.push('</function>');
  return lines.join('\n');
}

/**
 * Rewrites Chat Completions messages for prompt mode: tool instructions join
 * the system message, assistant tool_calls become text, tool results become
 * user messages, and neighbours with the same role are merged (some servers
 * require alternating turns). Images in user messages are kept.
 */
export function toPromptToolMessages(messages = [], tools = [], options = {}) {
  const names = new Map();
  const out = [];
  const instructions = toolsInstructions(tools, options);
  let instructed = false;
  const push = (message) => {
    const last = out[out.length - 1];
    if (last && last.role === message.role && message.role !== 'system' && typeof last.content === 'string' && typeof message.content === 'string') {
      last.content += '\n\n' + message.content;
      return;
    }
    out.push(message);
  };
  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'system' || message.role === 'developer') {
      if (!instructed) { push({ role: 'system', content: textOf(message.content) + '\n' + instructions }); instructed = true; }
      else push({ role: 'system', content: textOf(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) if (call && call.id && call.function) names.set(call.id, call.function.name);
      const text = [textOf(message.content).trim(), ...calls.map(callAsText)].filter(Boolean).join('\n\n');
      push({ role: 'assistant', content: text || '(no reply)' });
      continue;
    }
    if (message.role === 'tool') {
      const name = message.name || names.get(message.tool_call_id) || 'function';
      push({ role: 'user', content: 'EXECUTION RESULT of [' + name + ']:\n' + textOf(message.content) });
      continue;
    }
    const { role, content } = message;
    push(Array.isArray(content) ? { role, content } : { role, content: textOf(content) });
  }
  if (!instructed) out.unshift({ role: 'system', content: instructions.trim() });
  return out;
}

/** True when system messages should travel inside the first user message. */
export function foldSystemMessages(config = {}, env = {}) {
  const forced = String(env && env.OASIS_SYSTEM_MESSAGES || '').toLowerCase();
  if (forced === 'system') return false;
  if (forced === 'user') return true;
  return config && config.systemMessages === 'user';
}

/**
 * For endpoints that drop system messages (some keyless playgrounds replace
 * them with their own): the first system text opens the first user message
 * inside <system_instructions>, and later system messages become user notes.
 */
export function withSystemInUserTurn(messages = []) {
  const leading = [];
  let at = 0;
  while (at < messages.length && messages[at] && (messages[at].role === 'system' || messages[at].role === 'developer')) leading.push(textOf(messages[at++].content));
  const rest = messages.slice(at).map((message) => message && (message.role === 'system' || message.role === 'developer')
    ? { role: 'user', content: '<system_reminder>\n' + textOf(message.content) + '\n</system_reminder>' }
    : message);
  if (!leading.length) return rest;
  const block = '<system_instructions>\n' + leading.join('\n\n') + '\n</system_instructions>';
  const first = rest.findIndex((message) => message && message.role === 'user');
  if (first < 0) return [{ role: 'user', content: block }, ...rest];
  const target = rest[first];
  rest[first] = Array.isArray(target.content)
    ? { ...target, content: [{ type: 'text', text: block }, ...target.content] }
    : { ...target, content: block + '\n\n' + textOf(target.content) };
  return rest;
}
