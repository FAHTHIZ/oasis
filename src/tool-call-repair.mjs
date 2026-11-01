// Tool-call repair for models that almost follow the function-calling contract.
//
// Smaller and local models (Qwen, Llama, Mistral, DeepSeek distills served via
// Ollama, LM Studio, vLLM or llama.cpp) routinely emit arguments with code
// fences, trailing commas, Python literals, raw newlines inside strings, or a
// JSON object encoded twice. Some never use native tool calls at all and write
// `<tool_call>{...}</tool_call>` or a fenced JSON block in the reply text.
//
// Everything here is conservative: strict JSON is always tried first, repairs
// only ever produce a plain JSON object, and text tool calls are accepted only
// when they name a tool the session actually exposes.

export class ToolArgumentsError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'ToolArgumentsError';
    this.raw = raw;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function stripFences(text) {
  const fenced = /^\s*```[\w-]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

// Walks the text once, tracking whether we're inside a JSON string, and fixes
// what's only fixable with that context: raw control characters inside strings,
// Python literals and trailing commas outside them.
function repairStructure(text) {
  let out = '';
  let inString = false;
  let quote = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue; }
      if (ch === quote) { inString = false; out += '"'; continue; }
      if (quote === "'" && ch === '"') { out += '\\"'; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += '"'; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    const word = /^(True|False|None)\b/.exec(text.slice(i));
    if (word && !/[\w$]/.test(text[i - 1] || '')) {
      out += word[1] === 'True' ? 'true' : word[1] === 'False' ? 'false' : 'null';
      i += word[1].length - 1;
      continue;
    }
    out += ch;
  }
  return { text: out, unterminatedString: inString };
}

// Closes brackets a model forgot when it stopped early, e.g. `{"path": "a.js"`.
function closeBrackets(text) {
  const stack = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString) return null;
  return text + stack.reverse().join('');
}

// Returns { args, repaired } for usable arguments, or throws ToolArgumentsError
// with a message the model can act on.
export function repairToolArguments(raw) {
  if (raw === undefined || raw === null) return { args: {}, repaired: raw !== undefined };
  if (isPlainObject(raw)) return { args: raw, repaired: false };
  if (typeof raw !== 'string') throw new ToolArgumentsError('Tool arguments must be a JSON object.', raw);
  const trimmed = raw.trim();
  if (!trimmed) return { args: {}, repaired: raw.length > 0 };
  const strict = tryParse(trimmed);
  if (strict.ok) {
    if (isPlainObject(strict.value)) return { args: strict.value, repaired: trimmed !== raw };
    // A JSON object serialized twice: "{\"path\":\"a.js\"}".
    if (typeof strict.value === 'string') {
      const inner = tryParse(strict.value.trim());
      if (inner.ok && isPlainObject(inner.value)) return { args: inner.value, repaired: true };
    }
    throw new ToolArgumentsError('Tool arguments must be a JSON object, not ' + (Array.isArray(strict.value) ? 'an array' : typeof strict.value) + '.', raw);
  }
  let candidate = stripFences(trimmed).trim();
  // Prose around the object: take the outermost {...}.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start > 0 || (end !== -1 && end < candidate.length - 1)) {
    if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1);
    else if (start !== -1) candidate = candidate.slice(start);
  }
  const attempts = [];
  attempts.push(candidate);
  const structural = repairStructure(candidate);
  attempts.push(structural.text);
  if (!structural.unterminatedString) {
    const closed = closeBrackets(structural.text);
    if (closed) attempts.push(closed);
  }
  for (const attempt of attempts) {
    const parsed = tryParse(attempt);
    if (parsed.ok && isPlainObject(parsed.value)) return { args: parsed.value, repaired: true };
  }
  const reason = (() => { try { JSON.parse(trimmed); return ''; } catch (error) { return error.message; } })();
  throw new ToolArgumentsError('Tool arguments were not valid JSON' + (reason ? ' (' + reason + ')' : '') + '. Resend the call with a single JSON object using double-quoted keys and strings.', raw);
}

// Pulls balanced {...} objects out of free text, respecting strings.
function balancedObjects(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        found.push({ start: i, end: j + 1, text: text.slice(i, j + 1) });
        i = j;
        break;
      }
    }
  }
  return found;
}

function asCall(value, toolNames) {
  if (!isPlainObject(value)) return null;
  const fn = isPlainObject(value.function) ? value.function : value;
  const name = typeof fn.name === 'string' ? fn.name.trim() : typeof value.tool === 'string' ? value.tool.trim() : '';
  if (!name || !toolNames.has(name)) return null;
  const rawArgs = fn.arguments ?? fn.parameters ?? fn.args ?? value.input ?? {};
  let args;
  try { args = repairToolArguments(rawArgs).args; } catch { return null; }
  return { name, args };
}

// Detects tool calls a model wrote as text instead of native tool calls.
// Recognized forms (only when the name matches an available tool):
//   <tool_call>{"name": ..., "arguments": {...}}</tool_call>   (Hermes, Qwen)
//   <function=name>{...}</function>                             (Llama 3.x)
//   ```json {"name": ..., "arguments": {...}} ```               (fenced JSON)
//   a reply that is nothing but {"name": ..., "arguments": {...}}
// Returns { calls: [{ name, args }], text } where text is the reply with the
// recognized calls removed, or null when nothing was recognized.
export function extractTextToolCalls(content, availableNames) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const toolNames = availableNames instanceof Set ? availableNames : new Set(availableNames || []);
  if (!toolNames.size) return null;
  const calls = [];
  const spans = [];
  // Call syntax inside a code fence is being shown or quoted (for example from
  // a file the model read), not invoked.
  const fences = [];
  for (const fence of content.matchAll(/```[\s\S]*?(?:```|$)/g)) fences.push([fence.index, fence.index + fence[0].length]);
  const quoted = (index) => fences.some(([from, to]) => index > from && index < to);
  const tagged = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  for (let match; (match = tagged.exec(content));) {
    if (quoted(match.index)) continue;
    for (const object of balancedObjects(match[1])) {
      const call = asCall(tryParse(object.text).ok ? JSON.parse(object.text) : (() => { try { return repairToolArguments(object.text).args; } catch { return null; } })(), toolNames);
      if (call) calls.push(call);
    }
    spans.push([match.index, match.index + match[0].length]);
  }
  const llama = /<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g;
  for (let match; (match = llama.exec(content));) {
    if (!toolNames.has(match[1]) || quoted(match.index)) continue;
    let args;
    try { args = repairToolArguments(match[2] || '{}').args; } catch { continue; }
    calls.push({ name: match[1], args });
    spans.push([match.index, match.index + match[0].length]);
  }
  if (!calls.length) {
    const fenced = /```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n?```/g;
    // A fenced call counts only when the reply is essentially just that call
    // (at most a short lead-in line). A fence inside an explanation is an
    // example for the user and must never run.
    const fencedBlocks = [...content.matchAll(/```(?:json|tool_call|tool)?\s*\n[\s\S]*?\n?```/g)];
    const prose = fencedBlocks.reduce((rest, block) => rest.replace(block[0], ''), content).trim();
    for (let match; prose.length <= 160 && !/\n\s*\S[\s\S]*\n\s*\S/.test(prose) && (match = fenced.exec(content));) {
      const parsed = tryParse(match[1].trim());
      const values = parsed.ok ? (Array.isArray(parsed.value) ? parsed.value : [parsed.value]) : [];
      const found = values.map((value) => asCall(value, toolNames)).filter(Boolean);
      if (found.length && found.length === values.length) {
        calls.push(...found);
        spans.push([match.index, match.index + match[0].length]);
      }
    }
  }
  if (!calls.length) {
    const whole = tryParse(content.trim());
    if (whole.ok) {
      const values = Array.isArray(whole.value) ? whole.value : [whole.value];
      const found = values.map((value) => asCall(value, toolNames)).filter(Boolean);
      if (found.length && found.length === values.length) return { calls: found, text: '' };
    }
  }
  if (!calls.length) return null;
  spans.sort((a, b) => b[0] - a[0]);
  let text = content;
  for (const [from, to] of spans) text = text.slice(0, from) + text.slice(to);
  return { calls, text: text.replace(/\n{3,}/g, '\n\n').trim() };
}
