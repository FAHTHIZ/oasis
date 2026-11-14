// text_to_speech: turn text into an audio file in the workspace through an
// OpenAI-compatible speech API (OpenAI gpt-4o-mini-tts / tts-1, or local servers
// such as Kokoro-FastAPI and openedai-speech that serve /v1/audio/speech).
//
// Enabled when a key is available (OASIS_TTS_API_KEY, or OPENAI_API_KEY with the
// default OpenAI endpoint) or the endpoint is on localhost. Settings:
// "textToSpeech": { "model", "baseUrl", "voice", "format" } or false; env
// OASIS_TTS_MODEL, OASIS_TTS_BASE_URL, OASIS_TTS_VOICE, OASIS_TTS=0. Each call asks
// first (the text is sent to the provider and may cost money) unless a permission
// rule allows text_to_speech.
import { redactProviderDetail } from './api-error.mjs';
import { saveGeneratedMedia } from './media-output.mjs';
import { speakable } from '../app/core/voice-mode.mjs';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const MAX_INPUT_CHARS = 4096;
const FORMATS = new Set(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']);

export const TEXT_TO_SPEECH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'text_to_speech',
    description: 'Convert text to spoken audio with the configured speech model and save it as an audio file in the workspace (mp3 by default). Use for narration, voice-overs, audio summaries, app sound prompts and accessibility checks. Up to 4,096 characters per call; split longer scripts into parts. Returns the saved path.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact words to speak.' },
        path: { type: 'string', description: 'Workspace path to save to, e.g. "audio/intro.mp3". Defaults to audio/<slug>.<format>.' },
        voice: { type: 'string', description: 'Voice name, e.g. alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer (OpenAI) or the local server\'s voice id.' },
        format: { type: 'string', description: 'mp3 (default), wav, opus, aac, flac or pcm.' },
        instructions: { type: 'string', description: 'Optional delivery notes for models that support them (tone, pace, accent).' },
        speed: { type: 'number', description: 'Playback speed from 0.25 to 4.0 (default 1.0).' }
      },
      required: ['text'],
      additionalProperties: false
    }
  }
};

export function textToSpeechConfig(env = process.env, settings = {}) {
  const fromSettings = settings && settings.textToSpeech;
  if (fromSettings === false || /^(0|false|off|no)$/i.test(String(env.OASIS_TTS || '').trim())) return null;
  const options = fromSettings && typeof fromSettings === 'object' ? fromSettings : {};
  const baseUrl = String(env.OASIS_TTS_BASE_URL || options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = env.OASIS_TTS_API_KEY || (baseUrl === DEFAULT_BASE ? env.OPENAI_API_KEY : '') || '';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(baseUrl + '/');
  if (!apiKey && !local) return null;
  const format = String(options.format || 'mp3').toLowerCase();
  return {
    baseUrl, apiKey,
    model: String(env.OASIS_TTS_MODEL || options.model || 'gpt-4o-mini-tts'),
    voice: String(env.OASIS_TTS_VOICE || options.voice || 'alloy'),
    format: FORMATS.has(format) ? format : 'mp3'
  };
}

/** One /audio/speech request; returns the audio bytes. Callers validate and approve. */
export async function synthesizeSpeech(config, { text, voice = config.voice, format = config.format, instructions = '', speed } = {}, { fetchImpl = fetch, signal } = {}) {
  const body = { model: config.model, input: text, voice, response_format: format };
  if (instructions) body.instructions = instructions;
  if (speed !== undefined) body.speed = speed;
  const headers = { 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) };
  const response = await fetchImpl(config.baseUrl + '/audio/speech', { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = detail;
    try { const parsed = JSON.parse(detail); message = parsed.error && (parsed.error.message || parsed.error) || detail; } catch {}
    throw new Error('Speech API error ' + response.status + ': ' + redactProviderDetail(String(message || 'request failed'), [config.apiKey]).slice(0, 400));
  }
  const type = String(response.headers.get('content-type') || '');
  if (/json|text\/html/.test(type)) throw new Error('The speech API returned ' + type.split(';')[0] + ' instead of audio.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 16) throw new Error('The speech API returned empty audio.');
  return bytes;
}

/**
 * Make a Markdown chat reply suitable for reading aloud: code blocks, inline code
 * markers, link targets, bare URLs, tables and list/heading markup are dropped or
 * simplified, and the result is capped at a sentence boundary.
 */
export function speakableText(markdown, limit = 1500) {
  return speakable(markdown, limit, 'The full reply is in the text message.');
}

/** Voice replies in chat gateways: "off" (default), "auto" (answer voice notes with voice) or "always". */
export function voiceReplyMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['auto', 'voice'].includes(mode)) return 'auto';
  if (['always', 'on', '1', 'true'].includes(mode)) return 'always';
  return 'off';
}

export async function textToSpeech(args = {}, { config, resolvePath, beforeWrite, approval, autoApprove = false, fetchImpl = fetch, signal } = {}) {
  if (!config) throw new Error('Text to speech is not configured. Set OASIS_TTS_API_KEY (or OPENAI_API_KEY), or point OASIS_TTS_BASE_URL at a local speech server.');
  const text = String(args.text || '').trim();
  if (!text) throw new Error('text_to_speech needs text.');
  if (text.length > MAX_INPUT_CHARS) throw new Error('The text is ' + text.length + ' characters; the limit is 4,096 per call. Split it into parts.');
  const format = String(args.format || config.format).toLowerCase();
  if (!FORMATS.has(format)) throw new Error('Unsupported format ' + format + '. Use ' + [...FORMATS].join(', ') + '.');
  const voice = String(args.voice || config.voice).trim();
  if (!/^[\w.+-]{1,64}$/.test(voice)) throw new Error('Voice names are 1-64 letters, digits, dots, dashes or underscores.');
  let speed;
  if (args.speed !== undefined) {
    speed = Number(args.speed);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('speed must be between 0.25 and 4.0.');
  }
  const instructions = args.instructions ? String(args.instructions).slice(0, 2000) : '';
  const host = new URL(config.baseUrl).host;
  if (!autoApprove) {
    const message = 'Turn this text into speech with ' + config.model + ' (voice ' + voice + ') at ' + host + '?\n  Text: ' + text.slice(0, 600) + (text.length > 600 ? '…' : '') + '\n  The text is sent to ' + host + '; this may cost money on your provider account.';
    if (!approval || !(await approval(message))) throw new Error('The user did not approve generating this audio.');
  }
  const bytes = await synthesizeSpeech(config, { text, voice, format, instructions, speed }, { fetchImpl, signal });
  const saved = await saveGeneratedMedia(bytes, { requestedPath: args.path, folder: 'audio', label: text, fallback: 'speech', extension: format, resolvePath, beforeWrite });
  return { path: saved, bytes: bytes.length, format, voice, model: config.model, characters: text.length };
}
