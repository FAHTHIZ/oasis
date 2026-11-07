/**
 * Provider transport contract.
 *
 * A transport turns an already-resolved provider configuration and message
 * history into a provider response. It deliberately does not own retry,
 * fallback, approval, permission, or agent-loop policy: those remain the
 * runtime's responsibility.
 *
 * The initial implementation wraps the existing request serializers and
 * stream parser. Future transports can implement the same interface for
 * alternative SDKs, local runtimes, gateways, or isolated execution models.
 */

import { openAIEndpoint, responsesEndpoint, anthropicEndpoint, toResponsesRequest, toAnthropicRequest, chatCompletionTool } from './provider-requests.mjs';
import { readProviderStream } from './provider-stream.mjs';

/**
 * Normalize a provider configuration into the transport input shape.
 *
 * @param {object} config Provider configuration.
 * @returns {object} Normalized transport request.
 */
export function normalizeTransportConfig(config) {
  if (!config || typeof config !== 'object') throw new TypeError('Provider configuration must be an object.');
  const protocol = String(config.protocol || '').trim();
  if (!protocol) throw new Error('Provider configuration is missing a protocol.');
  const baseURL = String(config.baseURL || '').trim().replace(/\/+$/, '');
  if (!baseURL) throw new Error('Provider configuration is missing a baseURL.');
  return {
    protocol,
    baseURL,
    model: String(config.model || '').trim(),
    apiKey: String(config.apiKey || ''),
    messages: Array.isArray(config.messages) ? config.messages : [],
    tools: Array.isArray(config.tools) ? config.tools : [],
    stream: config.stream !== false,
    signal: config.signal || undefined,
    timeoutMs: Number(config.timeoutMs) || 0,
    env: config.env || process.env
  };
}

/**
 * Endpoint for a provider request.
 *
 * @param {object} config Normalized transport configuration.
 * @returns {string} Absolute endpoint URL.
 */
export function transportEndpoint(config) {
  const normalized = normalizeTransportConfig(config);
  if (normalized.protocol === 'openai-responses') return responsesEndpoint(normalized.baseURL);
  if (normalized.protocol === 'anthropic') return anthropicEndpoint(normalized.baseURL);
  return openAIEndpoint(normalized.baseURL);
}

/**
 * Serialize a message history for the selected protocol.
 *
 * @param {object} config Normalized transport configuration.
 * @returns {object} Protocol-specific request body.
 */
export function transportRequestBody(config) {
  const normalized = normalizeTransportConfig(config);
  if (normalized.protocol === 'openai-responses') return toResponsesRequest(normalized.messages);
  if (normalized.protocol === 'anthropic') return toAnthropicRequest(normalized.messages);
  return {
    model: normalized.model,
    messages: normalized.messages.filter((message) => message.role !== 'system' || true),
    tools: normalized.tools.map(chatCompletionTool)
  };
}

/**
 * Read a provider response stream into the runtime's normalized result.
 *
 * @param {Response} response Fetch response.
 * @param {string} protocol Provider protocol.
 * @param {(delta: string) => void} onDelta Text delta callback.
 * @param {(progress: unknown) => void} [onProgress] Provider progress callback.
 * @returns {Promise<object>} Normalized provider response.
 */
export function transportReadStream(response, protocol, onDelta, onProgress) {
  return readProviderStream(response, protocol, onDelta, onProgress);
}

/**
 * The stable interface every provider transport must implement.
 *
 * @typedef {object} ModelTransport
 * @property {(config: object) => string} endpoint
 * @property {(config: object) => object} requestBody
 * @property {(response: Response, protocol: string, onDelta: Function, onProgress?: Function) => Promise<object>} readStream
 */

export const defaultModelTransport = Object.freeze({
  endpoint: transportEndpoint,
  requestBody: transportRequestBody,
  readStream: transportReadStream
});
