// generate_image: create or edit images through an OpenAI-compatible Images API
// (OpenAI gpt-image-1 / dall-e-3, Google's OpenAI-compatible Gemini endpoint, LocalAI,
// or any proxy that speaks /images/generations and /images/edits) and save them
// into the workspace.
//
// Enabled when an image key is available: OASIS_IMAGE_API_KEY, or OPENAI_API_KEY with
// the default OpenAI endpoint. Settings: "imageGeneration": { "model", "baseUrl", "size" }
// or false to turn it off; env OASIS_IMAGE_MODEL, OASIS_IMAGE_BASE_URL,
// OASIS_IMAGE_GENERATION=0. Each call asks first (it sends the prompt to the provider
// and may cost money) unless a permission rule allows generate_image.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { saveGeneratedMedia } from './media-output.mjs';
import { sniffImageType } from './images.mjs';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const MAX_INPUT_IMAGE = 20 * 1024 * 1024;
const SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '512x512', '256x256']);

export const GENERATE_IMAGE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image from a text prompt, or edit existing workspace images (input_images), with the configured image model, and save it as a PNG/JPEG/WebP file in the workspace. Use for app icons, illustrations, placeholder art, diagrams-as-pictures and mockups. Describe subject, style, composition, colors and any exact text. Then reference the saved path; use read_file on it to look at the result.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw (or how to change input_images).' },
        path: { type: 'string', description: 'Workspace path to save to, e.g. "assets/hero.png". Defaults to images/<slug>.png.' },
        input_images: { type: 'array', items: { type: 'string' }, description: 'Optional workspace image paths to edit or use as references.' },
        size: { type: 'string', description: 'auto, 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait), 1792x1024 or 1024x1792.' },
        quality: { type: 'string', description: 'auto, low, medium, high (gpt-image) or standard/hd (dall-e-3).' },
        background: { type: 'string', description: 'transparent, opaque or auto (gpt-image models).' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  }
};

export function imageGenerationConfig(env = process.env, settings = {}) {
  const fromSettings = settings && settings.imageGeneration;
  if (fromSettings === false || env.OASIS_IMAGE_GENERATION === '0') return null;
  const options = fromSettings && typeof fromSettings === 'object' ? fromSettings : {};
  const baseUrl = String(env.OASIS_IMAGE_BASE_URL || options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = env.OASIS_IMAGE_API_KEY || (baseUrl === DEFAULT_BASE ? env.OPENAI_API_KEY : '') || '';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(baseUrl + '/');
  if (!apiKey && !local) return null;
  return { baseUrl, apiKey, model: String(env.OASIS_IMAGE_MODEL || options.model || 'gpt-image-1'), size: String(options.size || 'auto') };
}

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function extensionFor(bytes) {
  return EXTENSIONS[sniffImageType(bytes)] || 'png';
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}

async function decodeResult(item, fetchImpl, signal) {
  if (item && item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item && item.url) {
    const response = await fetchImpl(item.url, { signal });
    if (!response.ok) throw new Error('Could not download the generated image: HTTP ' + response.status);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('The image API returned no image.');
}

/**
 * resolvePath(rel) -> { absolute, relative } inside the workspace (throws outside it).
 */
export async function generateImage(args = {}, { config, resolvePath, beforeWrite, approval, autoApprove = false, fetchImpl = fetch, signal } = {}) {
  if (!config) throw new Error('Image generation is not configured. Set OASIS_IMAGE_API_KEY (or OPENAI_API_KEY), and optionally OASIS_IMAGE_MODEL / OASIS_IMAGE_BASE_URL.');
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('generate_image needs a prompt.');
  if (prompt.length > 32000) throw new Error('The prompt is too long (32,000 characters at most).');
  const size = args.size ? String(args.size) : config.size;
  if (size && !SIZES.has(size)) throw new Error('Unsupported size ' + size + '. Use ' + [...SIZES].join(', ') + '.');
  const inputs = Array.isArray(args.input_images) ? args.input_images.slice(0, 10) : [];
  const files = [];
  for (const input of inputs) {
    const target = await resolvePath(String(input));
    const info = await stat(target.absolute);
    if (!info.isFile() || info.size > MAX_INPUT_IMAGE) throw new Error(input + ' is not an image file under 20 MB.');
    files.push({ ...target, bytes: await readFile(target.absolute) });
  }
  const host = new URL(config.baseUrl).host;
  if (!autoApprove) {
    const message = (files.length ? 'Edit ' + files.map((f) => f.relative).join(', ') + ' with ' : 'Generate an image with ') + config.model + ' at ' + host + '?\n  Prompt: ' + prompt.slice(0, 600) + (prompt.length > 600 ? '…' : '') + (files.length ? '\n  The input images are uploaded to ' + host + '.' : '') + '\n  This may cost money on your provider account.';
    if (!approval || !(await approval(message))) throw new Error('The user did not approve generating this image.');
  }
  const headers = config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {};
  let response;
  if (files.length) {
    const form = new FormData();
    form.set('model', config.model);
    form.set('prompt', prompt);
    if (size && size !== 'auto') form.set('size', size);
    if (args.quality) form.set('quality', String(args.quality));
    if (args.background) form.set('background', String(args.background));
    for (const file of files) form.append(files.length > 1 ? 'image[]' : 'image', new Blob([file.bytes], { type: mimeFor(file.absolute) }), path.basename(file.absolute));
    response = await fetchImpl(config.baseUrl + '/images/edits', { method: 'POST', headers, body: form, signal });
  } else {
    const body = { model: config.model, prompt, n: 1 };
    if (size && size !== 'auto') body.size = size;
    if (args.quality) body.quality = String(args.quality);
    if (args.background) body.background = String(args.background);
    if (/^dall-e/.test(config.model)) body.response_format = 'b64_json';
    response = await fetchImpl(config.baseUrl + '/images/generations', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error('Image API error ' + response.status + ': ' + String(data && data.error && (data.error.message || data.error) || 'request failed').slice(0, 400));
  const item = data && Array.isArray(data.data) ? data.data[0] : null;
  const bytes = await decodeResult(item, fetchImpl, signal);
  if (bytes.length < 16) throw new Error('The image API returned an empty image.');
  const ext = extensionFor(bytes);
  const saved = await saveGeneratedMedia(bytes, { requestedPath: args.path, folder: 'images', label: prompt, fallback: 'image', extension: ext, resolvePath, beforeWrite });
  return {
    path: saved,
    bytes: bytes.length,
    format: ext,
    model: config.model,
    ...(item && item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    ...(data && data.usage ? { usage: data.usage } : {}),
    note: 'Saved. Use read_file on the path to look at it.'
  };
}
