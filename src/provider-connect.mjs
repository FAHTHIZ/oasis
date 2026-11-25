// Paste-to-connect for the local runtime (the app served by `oasis web`,
// and `oasis connect` in a terminal). It reuses the app's smart
// connect: work out the provider from a pasted key or link, list the models it
// can use, rank them for agentic coding and prove the best one calls tools.
// The result becomes an ordinary runtime config with the next-best models of
// the same provider as the fallback chain.
import { smartConnect, parsePaste, maskSecret } from '../app/core/connect.mjs';
import { widenOllamaContext } from './local-context.mjs';
import { providerForEndpoint, providerApiKey, getProvider } from './provider-registry.mjs';

const APP_TO_RUNTIME = { openai: 'openai-compatible', anthropic: 'anthropic' };

export function runtimeConfigFromConnection(result, { fallbackCount = 3 } = {}) {
  const { connection, model } = result;
  const protocol = APP_TO_RUNTIME[connection.protocol] || 'openai-compatible';
  // Models the server itself marks as paid (on a keyless connection) or as
  // unable to call tools are poor backups: they would fail the same way.
  const unusable = new Set([...(result.unusable || []), ...(connection.skipModels || [])]);
  const usable = connection.models.filter((id) => id && id !== model && !unusable.has(id));
  // On a gateway the chosen model's own upstream (llm7/… on OmniRoute) is the
  // one known to be connected, so its siblings are the safest backups.
  const prefix = connection.provider === 'omniroute' && model.includes('/') ? model.slice(0, model.indexOf('/') + 1) : '';
  const ordered = prefix ? [...usable.filter((id) => id.startsWith(prefix)), ...usable.filter((id) => !id.startsWith(prefix))] : usable;
  const fallbacks = ordered.slice(0, fallbackCount);
  const apiKey = connection.apiKey || '';
  // Connecting proved the endpoint answers without a key (Pollinations, a
  // keyless gateway on the network), so remember that it needs none.
  return { protocol, baseURL: connection.baseURL, model, apiKey, fallbackModel: fallbacks.join(','), ...(apiKey ? {} : { keyless: true }) };
}

/**
 * Connect from pasted text. Returns { config, label, models, toolCalling, notes, githubToken }.
 * Throws a readable error when nothing in the text points at a model.
 */
// A bare loopback address of a registry server that reads its own key variable
// (OASIS Route on :8081 reads OASIS_ROUTE_API_KEY): the key for that server, or ''.
// Only loopback, and only that server's own variable, so no key goes elsewhere.
export function localServerKey(parsed, env = process.env) {
  if (parsed.keys.length || parsed.urls.length !== 1) return { key: '', name: '' };
  let url;
  try { url = new URL(parsed.urls[0].url || parsed.urls[0]); } catch { return { key: '', name: '' }; }
  if (!/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(url.hostname)) return { key: '', name: '' };
  const id = providerForEndpoint(url.href, undefined, { env });
  const key = id ? providerApiKey(id, env) : '';
  return { key, name: key ? (getProvider(id, { env })?.label || id) : '' };
}

export async function connectFromPaste(text, { fetchImpl = globalThis.fetch.bind(globalThis), onStatus = () => {}, allowPull = true, model = '', env = process.env } = {}) {
  const parsed = parsePaste(String(text || ''));
  if (!parsed.keys.length && !parsed.urls.length && !parsed.local) {
    throw new Error(parsed.githubTokens.length ? 'That is a GitHub token, not a model key. Paste a model API key or a model link.' : 'Paste an API key, a model page link or a local server address.');
  }
  const local = localServerKey(parsed, env);
  if (local.key) { onStatus('Using the ' + local.name + ' key from the environment'); text = String(text) + ' ' + local.key; }
  const result = await smartConnect(text, { fetchImpl, onStatus, allowPull, model });
  const config = runtimeConfigFromConnection(result);
  const notes = [...(result.notes || [])];
  // Ollama serves models with a 4K window by default, which silently cuts the
  // system prompt and tools. Point the config at a wide-window variant instead.
  const wide = await widenOllamaContext(config, { fetchImpl, onStatus }).catch(() => null);
  if (wide) {
    config.model = wide.model;
    // The variant replaces the original; neither belongs in its own fallback chain.
    config.fallbackModel = String(config.fallbackModel || '').split(',').filter((id) => id && id !== wide.model && id !== wide.from).join(',');
    notes.push('Using ' + wide.model + ' (' + wide.contextLength.toLocaleString('en-US') + '-token window) instead of ' + wide.from + '.');
  }
  return {
    config,
    label: result.connection.label,
    provider: result.connection.provider,
    models: result.connection.models.slice(0, 40),
    toolCalling: result.toolCalling,
    notes,
    masked: config.apiKey ? maskSecret(config.apiKey) : '',
    githubToken: result.githubToken || ''
  };
}
