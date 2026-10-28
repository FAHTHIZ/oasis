// Client-side MCP features: requests and notifications that servers send to OASIS.
//
//   ping                              -> {}
//   roots/list                        -> the workspace plus --add-dir directories as file:// roots
//   elicitation/create                -> Elicitation hooks, then a terminal form (or URL prompt),
//                                        then ElicitationResult hooks; declined when nobody can answer
//   notifications/tools/list_changed  -> re-fetches tools/list and refreshes the session's tools
//   notifications/message             -> kept in the server's log tail
//
// A client gets `host` (a mutable object) at construction; createSession sets host.session.
import { pathToFileURL } from 'node:url';
import { runHooks, hasHooks } from './hooks.mjs';

export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18';

export function clientCapabilities() {
  return { roots: { listChanged: true }, elicitation: {} };
}

export function sessionRoots(session) {
  if (!session) return [];
  const dirs = [session.root, ...(session.additionalDirectories || [])].filter(Boolean);
  return [...new Set(dirs)].map((dir, index) => ({ uri: pathToFileURL(dir).href, name: index === 0 ? 'workspace' : 'additional directory' }));
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

/** Handles one server -> client request. Returns a JSON-RPC response object. */
export async function handleServerRequest(client, message) {
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  const session = client.host && client.host.session;
  try {
    switch (message.method) {
      case 'ping': return reply({});
      case 'roots/list': return reply({ roots: sessionRoots(session) });
      case 'elicitation/create': {
        const params = message.params || {};
        if (!params.message || (params.mode !== 'url' && !params.requestedSchema)) return fail(JSON_RPC_INVALID_PARAMS, 'elicitation/create needs message and requestedSchema.');
        return reply(await elicit(session, client.config.name, params));
      }
      default: return fail(JSON_RPC_METHOD_NOT_FOUND, 'OASIS does not support ' + message.method + '.');
    }
  } catch (error) {
    return fail(-32603, error.message || String(error));
  }
}

/** Handles one server -> client notification. */
export async function handleServerNotification(client, message) {
  if (message.method === 'notifications/tools/list_changed') {
    if (typeof client.refreshTools === 'function') {
      try {
        await client.refreshTools();
        const session = client.host && client.host.session;
        if (session && typeof client.host.onToolsChanged === 'function') client.host.onToolsChanged(session, client);
      } catch {}
    }
    return;
  }
  if (message.method === 'notifications/message' && message.params) {
    const line = '[' + (message.params.level || 'info') + '] ' + (typeof message.params.data === 'string' ? message.params.data : JSON.stringify(message.params.data));
    client.stderrTail = ((client.stderrTail || '') + '\n' + line).slice(-6000);
  }
}

/** Routes a message from a server: requests get a response, notifications are handled. */
export async function routeServerMessage(client, message, send) {
  if (!message || typeof message.method !== 'string') return false;
  if (message.id !== undefined && message.id !== null) {
    const response = await handleServerRequest(client, message);
    try { await send(response); } catch {}
  } else {
    await handleServerNotification(client, message);
  }
  return true;
}

// ---------- Elicitation ----------

function pickHookAnswer(result) {
  const specific = result && result.hookSpecific;
  if (specific && typeof specific.action === 'string' && ['accept', 'decline', 'cancel'].includes(specific.action)) {
    return { action: specific.action, ...(specific.action === 'accept' && specific.content && typeof specific.content === 'object' ? { content: specific.content } : {}) };
  }
  return null;
}

/** Runs Elicitation hooks, the interactive handler, and ElicitationResult hooks. */
export async function elicit(session, serverName, params) {
  const mode = params.mode === 'url' ? 'url' : 'form';
  const base = { session_id: session && session.sessionId || 'unsaved', mcp_server_name: serverName, message: String(params.message || ''), mode, ...(mode === 'url' ? { url: params.url, elicitation_id: params.elicitationId } : { requested_schema: params.requestedSchema }) };
  const hookOpts = session && typeof session.hookOptionsFor === 'function' ? session.hookOptionsFor() : session ? { hooks: session.hooks || {}, root: session.root, env: process.env } : null;
  let answer = null;
  if (hookOpts && hasHooks(hookOpts.hooks, 'Elicitation')) {
    const result = await runHooks('Elicitation', base, hookOpts);
    if (session && session.hookMessages) session.hookMessages.push(...result.messages);
    if (result.blocked) answer = { action: 'decline' };
    else answer = pickHookAnswer(result);
  }
  if (!answer) {
    const prompt = session && typeof session.elicit === 'function' ? session.elicit : null;
    if (prompt) {
      try { answer = await prompt({ serverName, mode, message: base.message, schema: params.requestedSchema, url: params.url }); } catch { answer = { action: 'cancel' }; }
    } else {
      answer = { action: 'decline' };
    }
  }
  if (!answer || !['accept', 'decline', 'cancel'].includes(answer.action)) answer = { action: 'cancel' };
  if (answer.action === 'accept' && mode === 'form') {
    const checked = validateElicitationContent(params.requestedSchema, answer.content || {});
    answer = checked.ok ? { action: 'accept', content: checked.content } : { action: 'cancel' };
  }
  if (hookOpts && hasHooks(hookOpts.hooks, 'ElicitationResult')) {
    const result = await runHooks('ElicitationResult', { ...base, action: answer.action, ...(answer.content ? { content: answer.content } : {}) }, hookOpts);
    if (session && session.hookMessages) session.hookMessages.push(...result.messages);
    if (result.blocked) answer = { action: 'decline' };
    else answer = pickHookAnswer(result) || answer;
  }
  if (answer.action !== 'accept') delete answer.content;
  return answer;
}

/** Converts one typed answer to a value for a primitive schema. */
export function coerceElicitationValue(schema = {}, raw) {
  const text = String(raw == null ? '' : raw).trim();
  const enumValues = Array.isArray(schema.enum) ? schema.enum : Array.isArray(schema.oneOf) ? schema.oneOf.map((item) => item && item.const).filter((item) => item !== undefined) : null;
  if (schema.type === 'array') {
    const allowed = schema.items && (schema.items.enum || (schema.items.anyOf || []).map((item) => item.const));
    const parts = text.split(/[,\s]+/).filter(Boolean).map((part) => /^\d+$/.test(part) && allowed && allowed[Number(part) - 1] !== undefined ? allowed[Number(part) - 1] : part);
    if (allowed && parts.some((part) => !allowed.includes(part))) return { error: 'Choose from: ' + allowed.join(', ') };
    if (schema.minItems && parts.length < schema.minItems) return { error: 'Pick at least ' + schema.minItems + '.' };
    if (schema.maxItems && parts.length > schema.maxItems) return { error: 'Pick at most ' + schema.maxItems + '.' };
    return { value: parts };
  }
  if (enumValues) {
    if (/^\d+$/.test(text) && enumValues[Number(text) - 1] !== undefined) return { value: enumValues[Number(text) - 1] };
    const hit = enumValues.find((item) => String(item).toLowerCase() === text.toLowerCase());
    return hit === undefined ? { error: 'Choose one of: ' + enumValues.join(', ') } : { value: hit };
  }
  if (schema.type === 'boolean') {
    if (/^(y|yes|true|1|on)$/i.test(text)) return { value: true };
    if (/^(n|no|false|0|off)$/i.test(text)) return { value: false };
    return { error: 'Answer yes or no.' };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const value = Number(text);
    if (!text || !Number.isFinite(value)) return { error: 'Enter a number.' };
    if (schema.type === 'integer' && !Number.isInteger(value)) return { error: 'Enter a whole number.' };
    if (schema.minimum !== undefined && value < schema.minimum) return { error: 'Must be at least ' + schema.minimum + '.' };
    if (schema.maximum !== undefined && value > schema.maximum) return { error: 'Must be at most ' + schema.maximum + '.' };
    return { value };
  }
  if (schema.minLength !== undefined && text.length < schema.minLength) return { error: 'Must be at least ' + schema.minLength + ' characters.' };
  if (schema.maxLength !== undefined && text.length > schema.maxLength) return { error: 'Must be at most ' + schema.maxLength + ' characters.' };
  if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return { error: 'Enter an email address.' };
  if (schema.format === 'uri') { try { new URL(text); } catch { return { error: 'Enter a full URL.' }; } }
  if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: 'Use YYYY-MM-DD.' };
  if (schema.format === 'date-time' && Number.isNaN(Date.parse(text))) return { error: 'Enter a date and time.' };
  return { value: text };
}

/** Checks accepted content against the requested schema (required fields, types). */
export function validateElicitationContent(schema = {}, content = {}) {
  const properties = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema && schema.required) ? schema.required : [];
  const out = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (content[key] === undefined || content[key] === '') {
      if (prop && prop.default !== undefined) { out[key] = prop.default; continue; }
      if (required.includes(key)) return { ok: false, error: 'Missing required field ' + key + '.' };
      continue;
    }
    const value = content[key];
    const raw = Array.isArray(value) ? value.join(',') : typeof value === 'boolean' ? (value ? 'yes' : 'no') : value;
    const checked = coerceElicitationValue(prop || {}, raw);
    if (checked.error) return { ok: false, error: key + ': ' + checked.error };
    out[key] = checked.value;
  }
  return { ok: true, content: out };
}

/**
 * Terminal form for an elicitation. ask(question) reads one line; write(text) prints.
 * Returns { action, content? }.
 */
export async function askElicitationInTerminal(request, { ask, write, openUrl } = {}) {
  write('\n[mcp] ' + request.serverName + ' asks: ' + request.message + '\n');
  if (request.mode === 'url') {
    write('  Open this URL to continue: ' + request.url + '\n');
    const choice = String(await ask('  Open it now? [y]es / [n]o (decline) / [c]ancel > ')).trim().toLowerCase();
    if (choice.startsWith('c')) return { action: 'cancel' };
    if (choice.startsWith('n')) return { action: 'decline' };
    if (typeof openUrl === 'function') { try { await openUrl(request.url); } catch {} }
    return { action: 'accept' };
  }
  const schema = request.schema || {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const start = String(await ask('  Answer? [Enter] fill in / [d]ecline / [c]ancel > ')).trim().toLowerCase();
  if (start.startsWith('c')) return { action: 'cancel' };
  if (start.startsWith('d') || start.startsWith('n')) return { action: 'decline' };
  const content = {};
  for (const [key, prop] of Object.entries(properties)) {
    const label = (prop.title || key) + (required.has(key) ? '' : ' (optional)');
    if (prop.description) write('  ' + prop.description + '\n');
    const options = prop.enum || (prop.oneOf || []).map((item) => item.const) || [];
    const items = prop.type === 'array' && prop.items ? (prop.items.enum || (prop.items.anyOf || []).map((item) => item.const)) : null;
    const list = items || (options.length ? options : null);
    if (list) list.forEach((option, index) => write('    ' + (index + 1) + '. ' + option + '\n'));
    const hint = prop.type === 'boolean' ? ' [y/n]' : '';
    const fallback = prop.default !== undefined ? ' [' + prop.default + ']' : '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = String(await ask('  ' + label + hint + fallback + ': '));
      if (!raw.trim()) {
        if (prop.default !== undefined) { content[key] = prop.default; break; }
        if (!required.has(key)) break;
        write('  This field is required.\n');
        continue;
      }
      if (raw.trim() === '/cancel') return { action: 'cancel' };
      const checked = coerceElicitationValue(prop, raw);
      if (checked.error) { write('  ' + checked.error + '\n'); continue; }
      content[key] = checked.value;
      break;
    }
    if (required.has(key) && content[key] === undefined) return { action: 'cancel' };
  }
  return { action: 'accept', content };
}
