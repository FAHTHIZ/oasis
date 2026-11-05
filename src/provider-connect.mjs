// Paste-to-connect for the local runtime (the app served by `oasis web` or the
// desktop app, and `oasis connect` in a terminal). It reuses the app's smart
// connect: work out the provider from a pasted key or link, list the models it
// can use, rank them for agentic coding and prove the best one calls tools.
// The result becomes an ordinary runtime config with the next-best models of
// the same provider as the fallback chain.
import { smartConnect, parsePaste, maskSecret } from '../app/core/connect.mjs';

const APP_TO_RUNTIME = { openai: 'openai-compatible', anthropic: 'anthropic' };

export function runtimeConfigFromConnection(result, { fallbackCount = 3 } = {}) {
  const { connection, model } = result;
  const protocol = APP_TO_RUNTIME[connection.protocol] || 'openai-compatible';
  const unusable = new Set(result.unusable || []);
  const fallbacks = connection.models.filter((id) => id && id !== model && !unusable.has(id)).slice(0, fallbackCount);
  return { protocol, baseURL: connection.baseURL, model, apiKey: connection.apiKey || '', fallbackModel: fallbacks.join(',') };
}

/**
 * Connect from pasted text. Returns { config, label, models, toolCalling, notes, githubToken }.
 * Throws a readable error when nothing in the text points at a model.
 */
export async function connectFromPaste(text, { fetchImpl = globalThis.fetch.bind(globalThis), onStatus = () => {}, allowPull = true } = {}) {
  const parsed = parsePaste(String(text || ''));
  if (!parsed.keys.length && !parsed.urls.length && !parsed.local) {
    throw new Error(parsed.githubTokens.length ? 'That is a GitHub token, not a model key. Paste a model API key or a model link.' : 'Paste an API key, a model page link or a local server address.');
  }
  const result = await smartConnect(text, { fetchImpl, onStatus, allowPull });
  const config = runtimeConfigFromConnection(result);
  return {
    config,
    label: result.connection.label,
    provider: result.connection.provider,
    models: result.connection.models.slice(0, 40),
    toolCalling: result.toolCalling,
    notes: result.notes || [],
    masked: config.apiKey ? maskSecret(config.apiKey) : '',
    githubToken: result.githubToken || ''
  };
}
