// Voice dictation: record from the microphone with whatever recorder the system has
// (sox/rec, arecord, ffmpeg, or a command you set), then transcribe the WAV with an
// OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a local
// faster-whisper / whisper.cpp / LocalAI server...). The transcript is inserted into the
// prompt for you to review; it is never sent on its own.
//
// Nothing is recorded or uploaded unless voice is turned on (/voice on, or
// "voice": {"enabled": true}), and audio files live in a private temp dir that is
// removed afterwards.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactProviderDetail } from './api-error.mjs';
import { assertZeroBudgetService } from './cost-policy.mjs';

const MAX_RECORDING_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // OpenAI's limit for transcription uploads
const DEFAULT_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

function onPath(name, env) {
  const probe = process.platform === 'win32' ? spawnSync('where', [name], { env, stdio: 'ignore', windowsHide: true }) : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { env, stdio: 'ignore' });
  return probe.status === 0;
}

// Splits OASIS_VOICE_RECORD_COMMAND into argv without a shell; {file} is replaced
// by the output path. Quotes ("…" or '…') group words.
export function splitCommand(text) {
  const out = [];
  let current = '';
  let quote = '';
  let has = false;
  for (const char of String(text || '')) {
    if (quote) { if (char === quote) quote = ''; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; has = true; continue; }
    if (/\s/.test(char)) { if (has || current) out.push(current); current = ''; has = false; continue; }
    current += char;
  }
  if (has || current) out.push(current);
  return out;
}

/** Picks a recorder. Returns { name, command, args(file) } or null. */
export function findRecorder({ env = process.env, platform = process.platform, has = (name) => onPath(name, env) } = {}) {
  const custom = String(env.OASIS_VOICE_RECORD_COMMAND || '').trim();
  if (custom) {
    const argv = splitCommand(custom);
    if (!argv.length) return null;
    return { name: 'custom', command: argv[0], args: (file) => argv.slice(1).map((part) => part.split('{file}').join(file)).concat(argv.some((part) => part.includes('{file}')) ? [] : [file]) };
  }
  const rate = ['-r', '16000', '-c', '1', '-b', '16'];
  if (has('rec')) return { name: 'sox', command: 'rec', args: (file) => ['-q', ...rate, file] };
  if (has('sox')) return { name: 'sox', command: 'sox', args: (file) => ['-q', '-d', ...rate, file] };
  if (platform === 'linux' && has('arecord')) return { name: 'arecord', command: 'arecord', args: (file) => ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', file] };
  if (has('ffmpeg')) {
    const device = env.OASIS_VOICE_DEVICE;
    const input = platform === 'darwin' ? ['-f', 'avfoundation', '-i', device || ':0']
      : platform === 'win32' ? (device ? ['-f', 'dshow', '-i', 'audio=' + device] : null)
        : ['-f', 'pulse', '-i', device || 'default'];
    if (input) return { name: 'ffmpeg', command: 'ffmpeg', args: (file) => ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-ac', '1', '-ar', '16000', '-y', file] };
  }
  return null;
}

export function recorderAdvice(platform = process.platform) {
  if (platform === 'darwin') return 'Install a recorder: brew install sox (or ffmpeg).';
  if (platform === 'win32') return 'Install sox (https://sourceforge.net/projects/sox/) or ffmpeg and set OASIS_VOICE_DEVICE to your microphone name, or set OASIS_VOICE_RECORD_COMMAND.';
  return 'Install a recorder: sox (apt install sox), alsa-utils (arecord) or ffmpeg.';
}

/**
 * Starts recording. Returns { stop(): Promise<file>, cancel(): Promise<void>, file }.
 * Recording stops on its own after MAX_RECORDING_MS.
 */
export async function startRecording({ env = process.env, recorder = findRecorder({ env }), spawnImpl = spawn, maxMs = MAX_RECORDING_MS } = {}) {
  if (!recorder) throw new Error('No audio recorder found. ' + recorderAdvice());
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-voice-'));
  const file = path.join(dir, 'dictation.wav');
  let stderr = '';
  const child = spawnImpl(recorder.command, recorder.args(file), { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  child.stderr && child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', (error) => resolve({ error })); });
  const timer = setTimeout(() => stopChild(), maxMs);
  timer.unref && timer.unref();
  let stopping = null;
  function stopChild() {
    if (stopping) return stopping;
    clearTimeout(timer);
    // ffmpeg finishes the file on "q"; sox and arecord on SIGINT. Fall back to SIGTERM/SIGKILL.
    try { if (recorder.name === 'ffmpeg' && child.stdin) child.stdin.end('q'); else child.kill('SIGINT'); } catch {}
    const term = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 1500);
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
    stopping = exited.finally(() => { clearTimeout(term); clearTimeout(kill); });
    return stopping;
  }
  const early = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 150))]);
  if (early && (early.error || (early.code && early.code !== 0))) {
    await rm(dir, { recursive: true, force: true });
    throw new Error('The recorder (' + recorder.command + ') could not start' + (early.error ? ': ' + early.error.message : stderr ? ': ' + stderr.trim().split('\n').pop() : '.') + ' Check microphone access for your terminal.');
  }
  return {
    file,
    recorder: recorder.name,
    async stop() {
      await stopChild();
      const info = await stat(file).catch(() => null);
      if (!info || info.size <= 44) { await rm(dir, { recursive: true, force: true }); throw new Error('Nothing was recorded' + (stderr ? ' (' + stderr.trim().split('\n').pop() + ')' : '') + '. Check microphone access for your terminal.'); }
      return file;
    },
    async cancel() { await stopChild(); await rm(dir, { recursive: true, force: true }); },
    async cleanup() { await rm(dir, { recursive: true, force: true }); }
  };
}

/** Where and how transcription happens, from settings.voice and environment. */
export function transcriptionTarget(settings = {}, env = process.env) {
  const voice = settings && typeof settings.voice === 'object' && settings.voice || {};
  const url = String(env.OASIS_VOICE_TRANSCRIPTION_URL || voice.transcriptionUrl || DEFAULT_URL);
  const parsed = new URL(url);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error('voice.transcriptionUrl must use https (plain http is only allowed for a local server).');
  const apiKey = env.OASIS_VOICE_API_KEY || (parsed.hostname === 'api.openai.com' ? env.OPENAI_API_KEY : parsed.hostname === 'api.groq.com' ? env.GROQ_API_KEY : '') || '';
  return {
    url,
    apiKey,
    model: String(env.OASIS_VOICE_MODEL || voice.model || (parsed.hostname === 'api.groq.com' ? 'whisper-large-v3-turbo' : DEFAULT_MODEL)),
    language: String(voice.language || env.OASIS_VOICE_LANGUAGE || '').slice(0, 12),
    keyterms: Array.isArray(voice.keyterms) ? voice.keyterms.map(String).filter(Boolean).slice(0, 50) : []
  };
}

/** Uploads a WAV file and returns the transcript text. */
export async function transcribe(file, options = {}) {
  return transcribeAudio(await readFile(file), { ...options, mediaType: 'audio/wav' });
}

// Formats browsers record (MediaRecorder) and OpenAI-compatible endpoints accept.
export const AUDIO_TYPES = new Map([['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/webm', 'webm'], ['audio/ogg', 'ogg'], ['audio/mp4', 'mp4'], ['audio/mpeg', 'mp3'], ['audio/x-m4a', 'm4a'], ['audio/flac', 'flac'], ['audio/x-flac', 'flac']]);

export function transcriptionReady(settings = {}, env = process.env) {
  try {
    const target = transcriptionTarget(settings, env);
    return Boolean(target.apiKey || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target.url).hostname));
  } catch { return false; }
}

/** Uploads recorded audio (a Buffer) and returns the transcript text. */
export async function transcribeAudio(audio, { settings = {}, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 60000, hints = [], mediaType = 'audio/wav' } = {}) {
  const target = transcriptionTarget(settings, env);
  // Zero-budget mode: only a local Whisper server or a route declared free (voice:MODEL).
  assertZeroBudgetService('voice', { baseUrl: target.url, model: target.model, apiKey: target.apiKey }, { session: { zeroBudget: settings && settings.zeroBudget === true, freeModels: settings && settings.freeModels }, env });
  if (!target.apiKey && new URL(target.url).hostname !== '127.0.0.1' && new URL(target.url).hostname !== 'localhost') {
    throw new Error('Voice transcription needs a key: set OPENAI_API_KEY (or OASIS_VOICE_API_KEY), or point voice.transcriptionUrl at a local Whisper server.');
  }
  const type = String(mediaType || '').split(';')[0].trim().toLowerCase();
  const extension = AUDIO_TYPES.get(type);
  if (!extension) throw new Error('Unsupported audio format: ' + (type || 'unknown') + '.');
  if (!audio || !audio.length) throw new Error('Nothing was recorded.');
  if (audio.length > MAX_UPLOAD_BYTES) throw new Error('The recording is too large to transcribe (over 25 MB).');
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), 'dictation.' + extension);
  form.append('model', target.model);
  form.append('response_format', 'json');
  if (target.language) form.append('language', target.language);
  // A short vocabulary hint (project and file names) makes technical words come out right.
  const words = [...new Set([...target.keyterms, ...hints.map(String)])].filter((word) => /^[\w.@/+-]{2,60}$/.test(word)).slice(0, 60);
  if (words.length) form.append('prompt', 'Software development dictation. Terms: ' + words.join(', '));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, { method: 'POST', body: form, headers: target.apiKey ? { authorization: 'Bearer ' + target.apiKey } : {}, signal: controller.signal, redirect: 'error' });
    const body = await response.text();
    if (!response.ok) {
      let detail = '';
      try { detail = JSON.parse(body).error.message; } catch { detail = body.slice(0, 200); }
      throw new Error('Transcription failed (HTTP ' + response.status + ')' + (detail ? ': ' + redactProviderDetail(String(detail), [target.apiKey]).slice(0, 200) : '.'));
    }
    let text;
    try { text = JSON.parse(body).text; } catch { text = body; }
    return String(text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Transcription timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function voiceEnabled(settings = {}, env = process.env) {
  if (settings && settings.voiceDisabledByPolicy) return false;
  if (/^(0|false|off)$/i.test(String(env.OASIS_VOICE || ''))) return false;
  if (/^(1|true|on)$/i.test(String(env.OASIS_VOICE || ''))) return true;
  return Boolean(settings && (settings.voiceEnabled === true || (settings.voice && settings.voice.enabled === true)));
}
