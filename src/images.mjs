// Image support for multimodal models: read_file on an image attaches it to the
// conversation, and provider converters turn attachments into image blocks.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from './tools.mjs';

export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const MAX_IMAGE_BYTES = 3_750_000; // ~5 MB once base64-encoded (Anthropic's per-image limit).
export const MAX_IMAGES_IN_REQUEST = 4;
export const IMAGE_TOKEN_ESTIMATE = 1600;

export function imageMediaType(file) {
  return IMAGE_TYPES[path.extname(String(file || '')).toLowerCase()] || null;
}

export function visionEnabled(config = {}, env = process.env) {
  const flag = String(env.OASIS_VISION || '').toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(flag)) return false;
  return config.vision !== false;
}

/**
 * Best-effort, tri-state capability check. A provider name alone does not prove
 * that the selected model accepts images. Recognized model families are hints,
 * not a substitute for the actual provider response.
 */
export function imageInputCapability(config = {}, env = process.env) {
  if (!visionEnabled(config, env)) {
    return { status: 'unsupported', reason: 'Image input is disabled by OASIS_VISION or the provider vision setting.' };
  }
  const override = String(env.OASIS_MODEL_VISION || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(override)) {
    return { status: 'unsupported', reason: 'OASIS_MODEL_VISION explicitly marks the active model as text-only.' };
  }
  if (['1', 'true', 'on', 'yes'].includes(override) || config.visionCapability === true) {
    return { status: 'supported', reason: 'Image support was explicitly declared for the active model.' };
  }

  const model = String(config.model || env.OASIS_MODEL || '').trim().toLowerCase();
  if (!model) return { status: 'unknown', reason: 'No active model ID is available to assess image support.' };
  const knownVision = [
    /(?:^|[/:_-])gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?|4\.5|5(?:\.\d+)?|4-turbo|4-vision)(?:$|[/:_-])/,
    /(?:^|[/:_-])o[134](?:-mini|-pro)?(?:$|[/:_-])/,
    /claude-(?:3(?:\.\d+)?|4(?:\.\d+)?|sonnet|opus|haiku)(?:$|[/:_-])/,
    /gemini-(?:1\.5|2(?:\.\d+)?|3)(?:$|[/:_-])/,
    /(?:^|[/:_-])(?:llava|bakllava|moondream|minicpm-v|qwen2(?:\.5)?-vl|qwen3-vl|llama3\.2-vision|gemma3)(?:$|[/:_-])/
  ];
  if (knownVision.some((pattern) => pattern.test(model))) {
    return { status: 'supported', reason: 'The model ID matches a recognized image-capable family; an API rejection overrides this hint.' };
  }
  const knownTextOnly = [
    /gpt-3\.5(?:$|[/:_-])/,
    /text-davinci|text-embedding|embedding-/,
    /claude-instant|claude-2(?:$|[/:_-])/,
    /(?:^|[/:_-])(?:llama3?\.1|gemma2)(?:$|[/:_-])/
  ];
  if (knownTextOnly.some((pattern) => pattern.test(model))) {
    return { status: 'unsupported', reason: 'The model ID matches a recognized text-only family.' };
  }
  return { status: 'unknown', reason: 'Image support cannot be verified from the configured model ID.' };
}

function sniffType(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function dimensions(buffer, type) {
  try {
    if (type === 'image/png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (type === 'image/gif') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (type === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {}
  return {};
}

// Returns a tool result; the base64 data is attached as a non-enumerable property
// so it never ends up in the JSON text the model (or logs) see.
export async function readImageFile(root, rawPath, options = {}) {
  const target = await resolveWorkspacePath(root, rawPath);
  const info = await stat(target.absolute);
  if (!info.isFile()) throw new Error('That path is not a file.');
  const relative = target.relative.split(path.sep).join('/');
  if (info.size > MAX_IMAGE_BYTES) throw new Error('Image is larger than the ' + Math.round(MAX_IMAGE_BYTES / 1e6 * 10) / 10 + ' MB limit. Resize or compress it first.');
  const buffer = await readFile(target.absolute);
  const mediaType = sniffType(buffer);
  if (!mediaType) throw new Error('This file does not contain a PNG, JPEG, GIF, or WebP image.');
  const result = { path: relative, image: true, mediaType, bytes: info.size, ...dimensions(buffer, mediaType) };
  if (!visionEnabled(options.config, options.env)) {
    result.note = 'Image input is turned off (OASIS_VISION=off or vision: false in the provider config), so only metadata is available.';
    return result;
  }
  result.note = 'The image is attached to this conversation for you to look at.';
  Object.defineProperty(result, 'imageData', { value: { mediaType, data: buffer.toString('base64') }, enumerable: false });
  return result;
}

// Only the most recent images are sent; older ones become a short text note.
function recentImageSet(messages) {
  const keep = new Set();
  for (let i = messages.length - 1; i >= 0 && keep.size < MAX_IMAGES_IN_REQUEST; i--) {
    if (Array.isArray(messages[i].images) && messages[i].images.length) keep.add(i);
  }
  return keep;
}

export function hasImages(messages) {
  return messages.some((message) => Array.isArray(message.images) && message.images.length);
}

// OpenAI chat completions: tool messages cannot carry images, so add one user
// message with the images after each block of tool results.
export function toChatMessagesWithImages(messages) {
  const keep = recentImageSet(messages);
  const out = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the previous tool calls:' }, ...pending] });
    pending = [];
  };
  messages.forEach((message, index) => {
    if (message.role !== 'tool') flush();
    const { images, ...rest } = message;
    if (Array.isArray(images) && images.length && message.role === 'tool') {
      if (keep.has(index)) for (const image of images) pending.push({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } });
      else rest.content = String(rest.content || '') + '\n[Image no longer attached to save context; read it again if needed.]';
    }
    if (Array.isArray(images) && images.length && message.role === 'user') {
      rest.content = keep.has(index)
        ? [{ type: 'text', text: String(message.content || '') }, ...images.map((image) => ({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } }))]
        : String(message.content || '') + '\n[Image no longer attached.]';
    }
    out.push(rest);
  });
  flush();
  return out;
}

export function anthropicImageBlocks(message, index, keep) {
  if (!Array.isArray(message.images) || !message.images.length || !keep.has(index)) return [];
  return message.images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }));
}

export function responsesImageItems(message, index, keep) {
  if (!Array.isArray(message.images) || !message.images.length || !keep.has(index)) return [];
  return message.images.map((image) => ({ type: 'input_image', image_url: 'data:' + image.mediaType + ';base64,' + image.data }));
}

export { recentImageSet };
