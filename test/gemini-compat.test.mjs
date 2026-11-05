// Gemini's OpenAI-compatible endpoint, as seen live on 2026-11-05:
// - a stray key under tools[].function fails the whole request (400);
// - Gemini 3 returns extra_content.google.thought_signature on tool calls and
//   rejects the next turn unless it is sent back;
// - errors arrive wrapped in an array: [{ error: {...} }].
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../src/tools.mjs';
import { chatCompletionTool, withProviderExtraContent, isGoogleGenerativeBaseURL, shortProviderReason, summarizeFallbackFailure } from '../src/agent.mjs';

const ALLOWED = new Set(['name', 'description', 'parameters', 'strict']);

test('every built-in tool keeps required inside parameters', () => {
  for (const tool of TOOL_DEFINITIONS) {
    const extra = Object.keys(tool.function).filter((key) => !ALLOWED.has(key));
    assert.deepEqual(extra, [], tool.function.name + ' has keys a strict server rejects');
    assert.equal(tool.function.parameters && tool.function.parameters.type, 'object', tool.function.name);
  }
});

test('chatCompletionTool drops keys outside the chat-completions tool shape', () => {
  const cleaned = chatCompletionTool({ type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} }, required: [], annotations: { readOnly: true } } });
  assert.deepEqual(cleaned, { type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} } } });
});

test('thought signatures go back to Gemini and nowhere else', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }] },
    { role: 'tool', tool_call_id: 'a', content: '[]' }
  ];
  assert.equal(withProviderExtraContent(messages, 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-flash'), messages);
  assert.equal(withProviderExtraContent(messages, 'http://127.0.0.1:4000/v1', 'gemini-3-flash'), messages, 'Gemini behind a gateway');
  const toOpenAI = withProviderExtraContent(messages, 'https://api.openai.com/v1', 'gpt-5');
  assert.equal(toOpenAI[1].tool_calls[0].extra_content, undefined);
  assert.equal(toOpenAI[1].tool_calls[0].function.name, 'list_files');
  assert.equal(messages[1].tool_calls[0].extra_content.google.thought_signature, 'sig', 'the session copy is untouched');
  assert.equal(isGoogleGenerativeBaseURL('https://generativelanguage.googleapis.com.evil.test/v1'), false);
});

test('fallback failures name every model and why', () => {
  const quota = Object.assign(new Error('Model provider returned HTTP 429: You exceeded your current quota. Generate content requests per day limit exceeded on Free Tier. Please retry in 21h11m1.6s.. Check the configured OpenAI-compatible chat completions endpoint, model name, credentials, and tool-calling support.'), { status: 429 });
  const gone = Object.assign(new Error('Model provider returned HTTP 404: This model models/gemini-2.5-flash is no longer available to new users.'), { status: 404 });
  assert.equal(shortProviderReason(quota), 'daily free-tier quota used up (retry in 21h11m)');
  assert.equal(shortProviderReason(gone), 'model retired by the provider');
  const error = summarizeFallbackFailure(gone, [{ model: 'gemini-3.6-flash', reason: shortProviderReason(quota) }, { model: 'gemini-2.5-flash', reason: shortProviderReason(gone) }]);
  assert.match(error.message, /All 2 models in the fallback chain failed/);
  assert.match(error.message, /gemini-3\.6-flash: daily free-tier quota used up \(retry in 21h11m\)/);
  assert.match(error.message, /no longer available/, 'the original message is kept for callers that read it');
  assert.equal(error.status, 404);
  const single = new Error('x');
  assert.equal(summarizeFallbackFailure(single, []).message, 'x');
});
