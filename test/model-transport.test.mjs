import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultModelTransport,
  normalizeTransportConfig,
  transportEndpoint,
  transportRequestBody
} from '../src/model-transport.mjs';

test('transport configuration is normalized and validated', () => {
  const config = normalizeTransportConfig({
    protocol: 'openai-compatible',
    baseURL: 'https://api.example.test/v1/',
    model: ' model ',
    apiKey: 'key',
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(config.protocol, 'openai-compatible');
  assert.equal(config.baseURL, 'https://api.example.test/v1');
  assert.equal(config.model, 'model');
  assert.equal(config.stream, true);
  assert.equal(transportEndpoint(config), 'https://api.example.test/v1/chat/completions');
});

test('transport selects protocol-specific endpoints', () => {
  assert.equal(
    transportEndpoint({ protocol: 'openai-responses', baseURL: 'https://api.example.test/v1' }),
    'https://api.example.test/v1/responses'
  );
  assert.equal(
    transportEndpoint({ protocol: 'anthropic', baseURL: 'https://api.example.test' }),
    'https://api.example.test/v1/messages'
  );
});

test('transport rejects incomplete configuration', () => {
  assert.throws(() => normalizeTransportConfig(null), TypeError);
  assert.throws(() => normalizeTransportConfig({ protocol: 'openai-compatible' }), /missing a baseURL/);
  assert.throws(() => normalizeTransportConfig({ baseURL: 'https://api.example.test' }), /missing a protocol/);
});

test('default transport exposes a stable interface', () => {
  assert.equal(typeof defaultModelTransport.endpoint, 'function');
  assert.equal(typeof defaultModelTransport.requestBody, 'function');
  assert.equal(typeof defaultModelTransport.readStream, 'function');
});
