import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, toAnthropicRequest, toResponsesRequest } from '../src/agent.mjs';
import { readImageFile, toChatMessagesWithImages, recentImageSet, MAX_IMAGES_IN_REQUEST } from '../src/images.mjs';
import { expandFileMentions } from '../src/commands.mjs';
import { saveSession, loadSession } from '../src/sessions.mjs';
import { estimateTokens } from '../src/context.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-img-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-img-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await writeFile(path.join(root, 'shot.png'), PNG);
  await writeFile(path.join(root, 'fake.png'), 'not an image');
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') } };
}

test('readImageFile validates content, reports size, and hides base64 from JSON', async (t) => {
  const { root, env } = await workspace(t);
  const result = await readImageFile(root, 'shot.png', { env });
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.imageData.data, PNG.toString('base64'));
  assert.doesNotMatch(JSON.stringify(result), /iVBOR/);
  await assert.rejects(readImageFile(root, 'fake.png', { env }), /does not contain a PNG/);
  const off = await readImageFile(root, 'shot.png', { env: { ...env, OASIS_VISION: 'off' } });
  assert.equal(off.imageData, undefined);
  assert.match(off.note, /turned off/);
});

test('read_file on an image sends it to an OpenAI-compatible model after the tool results', async (t) => {
  const { root, env } = await workspace(t);
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'shot.png' }), { content: 'A tiny transparent pixel.' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'What is in shot.png?', { autoApprove: true, env, approval: async () => true });
  assert.equal(result.text, 'A tiny transparent pixel.');
  const messages = requests[1].messages;
  const toolIndex = messages.findIndex((message) => message.role === 'tool');
  assert.doesNotMatch(messages[toolIndex].content, /iVBOR/);
  assert.equal(messages[toolIndex].images, undefined);
  const imageMessage = messages[toolIndex + 1];
  assert.equal(imageMessage.role, 'user');
  assert.equal(imageMessage.content[1].type, 'image_url');
  assert.match(imageMessage.content[1].image_url.url, /^data:image\/png;base64,iVBOR/);
  assert.ok(estimateTokens(session.messages) > 1600);

  const saved = await saveSession(session, { env });
  const restored = await loadSession(root, saved.id, { env });
  assert.ok(restored.messages.every((message) => !message.images));
});

test('Anthropic and Responses conversions carry image blocks; only recent images are kept', () => {
  const image = { mediaType: 'image/png', data: 'AAAA' };
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'look', images: [image] },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'read_file', content: '{"image":true}', images: [image] }
  ];
  const anthropic = toAnthropicRequest(messages);
  assert.deepEqual(anthropic.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  const toolResult = anthropic.messages[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.content[1].type, 'image');

  const responses = toResponsesRequest(messages);
  assert.deepEqual(responses.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
  assert.equal(responses.input.at(-2).type, 'function_call_output');
  assert.equal(responses.input.at(-1).content[1].type, 'input_image');

  const many = [{ role: 'system', content: 's' }];
  for (let i = 0; i < MAX_IMAGES_IN_REQUEST + 2; i++) many.push({ role: 'user', content: 'img ' + i, images: [image] }, { role: 'assistant', content: 'ok' });
  const chat = toChatMessagesWithImages(many);
  const withImages = chat.filter((message) => Array.isArray(message.content));
  assert.equal(withImages.length, MAX_IMAGES_IN_REQUEST);
  assert.match(chat[1].content, /no longer attached/);
});

test('@image mentions attach images unless vision is off', async (t) => {
  const { root } = await workspace(t);
  const expanded = await expandFileMentions(root, 'fix the layout in @shot.png');
  assert.equal(expanded.images.length, 1);
  assert.equal(expanded.images[0].mediaType, 'image/png');
  assert.match(expanded.text, /<image path="shot.png">attached<\/image>/);
  const off = await expandFileMentions(root, 'see @shot.png', { images: false });
  assert.equal(off.images.length, 0);
});

test('Anthropic requests get prompt-cache breakpoints on system, tools, and the newest message', async () => {
  const { applyAnthropicCacheBreakpoints, promptCachingEnabled } = await import('../src/agent.mjs');
  const request = toAnthropicRequest([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'read_file', content: 'data' }
  ]);
  const tools = [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }];
  applyAnthropicCacheBreakpoints(request, tools);
  assert.deepEqual(request.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assert.equal(tools[0].cache_control, undefined);
  assert.deepEqual(tools[1].cache_control, { type: 'ephemeral' });
  // The user message before the latest assistant reply is where the previous request ended.
  assert.deepEqual(request.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(request.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(promptCachingEnabled({}, {}), true);
  assert.equal(promptCachingEnabled({}, { OASIS_PROMPT_CACHE: 'off' }), false);
  assert.equal(promptCachingEnabled({ promptCache: false }, {}), false);
});

test('images from more than four earlier messages are still sent', () => {
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  const messages = [];
  for (let i = 0; i < 8; i++) messages.push({ role: 'user', content: 'shot ' + i, images: [png] }, { role: 'assistant', content: 'ok' });
  const keep = recentImageSet(messages);
  assert.equal(keep.size, 8);
  const chat = toChatMessagesWithImages(messages);
  assert.ok(!chat.some((message) => typeof message.content === 'string' && /no longer attached/.test(message.content)));
});

test('the oldest images drop first once the request image budget is full', () => {
  const big = { mediaType: 'image/png', data: 'A'.repeat(1000) };
  const messages = Array.from({ length: MAX_IMAGES_IN_REQUEST + 5 }, (_, i) => ({ role: 'user', content: 'shot ' + i, images: [big] }));
  const keep = recentImageSet(messages);
  assert.equal(keep.size, MAX_IMAGES_IN_REQUEST);
  assert.ok(keep.has(messages.length - 1) && !keep.has(0));
  // By bytes: two 600-byte images fit in 1500, a third does not.
  const sized = recentImageSet(messages.slice(0, 5).map((m) => ({ ...m, images: [{ mediaType: 'image/png', data: 'A'.repeat(600) }] })), { maxBytes: 1500 });
  assert.deepEqual([...sized].sort(), [3, 4]);
  // The newest image message is kept even when it alone is over the budget.
  assert.deepEqual([...recentImageSet(messages.slice(0, 2), { maxBytes: 10 })], [1]);
});
