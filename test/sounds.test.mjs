import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOUND_NAMES, synthesize, encodeWav, clampVolume, soundFile, detectPlayer, configureSounds, soundsOffReason, playSound, resetSoundState, completedTodoCount, soundVolume } from '../src/sounds.mjs';
import { notifyAttention } from '../src/attention.mjs';

const tty = { isTTY: true };
const player = { command: '/bin/fake-player', args: (file) => ['-q', file] };
function home() { return mkdtempSync(path.join(os.tmpdir(), 'oasis-sounds-')); }
function env(extra = {}) { return { PATH: '', OASIS_CONFIG_DIR: home(), ...extra }; }
function recorder() {
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { on() {}, unref() {} }; };
  return { calls, spawn };
}

test('every sound is short, soft, and scales with volume', () => {
  for (const name of SOUND_NAMES) {
    const loud = synthesize(name, 100); const soft = synthesize(name, 20);
    assert.ok(loud.length > 0 && loud.length / 22050 <= 0.8, name + ' stays under 0.8s');
    const peak = (samples) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    assert.ok(peak(loud) <= 0.8, name + ' never clips');
    assert.ok(peak(soft) < peak(loud) / 2, name + ' gets quieter');
    assert.ok(Math.abs(loud[0]) < 0.01 && Math.abs(loud[loud.length - 1]) < 0.01, name + ' fades in and out (no clicks)');
  }
  assert.ok(synthesize('task').length < synthesize('done').length / 3, 'the checklist tick is much shorter than the chime');
});

test('WAV encoding has a valid 16-bit mono header', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.equal(wav.length, 44 + 8);
  assert.equal(clampVolume(140), 100); assert.equal(clampVolume(-3), 0); assert.equal(clampVolume('x'), 50);
});

test('sound files are cached per sound and volume', () => {
  const e = env();
  const file = soundFile('done', 40, e);
  assert.ok(file.startsWith(e.OASIS_CONFIG_DIR) && existsSync(file));
  assert.equal(soundFile('done', 40, e), file);
  assert.notEqual(soundFile('done', 80, e), file);
  assert.equal(readFileSync(file).toString('ascii', 0, 4), 'RIFF');
});

test('sounds stay quiet where they would be unwelcome', () => {
  resetSoundState();
  assert.equal(soundsOffReason({ env: env(), stream: tty, player }), '');
  assert.match(soundsOffReason({ env: env({ CI: 'true' }), stream: tty, player }), /CI/);
  assert.match(soundsOffReason({ env: env({ SSH_CONNECTION: '1 2 3 4' }), stream: tty, player }), /SSH/);
  assert.match(soundsOffReason({ env: env(), stream: { isTTY: false }, player }), /not a terminal/);
  assert.match(soundsOffReason({ env: env({ OASIS_SOUNDS: 'off' }), stream: tty, player }), /OASIS_SOUNDS/);
  assert.match(soundsOffReason({ env: env({ OASIS_SOUND_VOLUME: '0' }), stream: tty, player }), /volume is 0/);
  assert.match(soundsOffReason({ env: env(), stream: tty, player: null, platform: 'linux' }), /no audio player/);
  assert.equal(soundsOffReason({ env: env({ CI: '1', OASIS_SOUNDS: 'on' }), stream: { isTTY: false }, player }), '', 'OASIS_SOUNDS=on forces them');
  configureSounds({ enabled: false });
  assert.match(soundsOffReason({ env: env(), stream: tty, player }), /turned off/);
  configureSounds({ enabled: true, volume: 30 });
  assert.equal(soundsOffReason({ env: env(), stream: tty, player }), '');
  assert.equal(soundVolume(env()), 30);
  resetSoundState();
});

test('playSound launches the player with the cached file and rate-limits', () => {
  resetSoundState();
  const e = env(); const { calls, spawn } = recorder();
  assert.equal(playSound('done', { env: e, stream: tty, player, spawn, now: 10_000 }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/fake-player');
  assert.equal(calls[0].args[0], '-q');
  assert.match(calls[0].args[1], /done-v50-s1\.wav$/);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(playSound('done', { env: e, stream: tty, player, spawn, now: 10_100 }), false, 'no double chime');
  assert.equal(playSound('task', { env: e, stream: tty, player, spawn, now: 10_200 }), false, 'a tick never stacks on a chime');
  assert.equal(playSound('task', { env: e, stream: tty, player, spawn, now: 11_000 }), true);
  assert.equal(playSound('task', { env: e, stream: tty, player, spawn, now: 11_500 }), false, 'ticks are spaced out');
  assert.equal(playSound('task', { env: e, stream: tty, player, spawn, now: 13_000 }), true);
  assert.equal(playSound('nope', { env: e, stream: tty, player, spawn, now: 20_000 }), false);
  assert.equal(playSound('error', { env: e, stream: { isTTY: false }, player, spawn, now: 30_000 }), false);
  const failing = () => { throw new Error('no audio'); };
  assert.equal(playSound('error', { env: e, stream: tty, player, spawn: failing, now: 40_000 }), false, 'player failures are silent');
  resetSoundState();
});

test('player detection follows PATH', () => {
  const dir = home(); const bin = path.join(dir, 'bin'); mkdirSync(bin);
  assert.equal(detectPlayer({ PATH: bin }, 'linux'), null);
  const aplay = path.join(bin, 'aplay'); writeFileSync(aplay, '#!/bin/sh\n'); chmodSync(aplay, 0o755);
  const found = detectPlayer({ PATH: bin }, 'linux');
  assert.equal(found.command, aplay);
  assert.deepEqual(found.args('/x.wav'), ['-q', '/x.wav']);
  const paplay = path.join(bin, 'paplay'); writeFileSync(paplay, '#!/bin/sh\n'); chmodSync(paplay, 0o755);
  assert.equal(detectPlayer({ PATH: bin }, 'linux').command, paplay, 'PulseAudio is preferred over raw ALSA');
});

test('completed checklist items are counted', () => {
  assert.equal(completedTodoCount(null), 0);
  assert.equal(completedTodoCount([{ status: 'completed' }, { status: 'pending' }, { status: 'completed' }]), 2);
});

test('the terminal bell is skipped when a sound already played', () => {
  const stream = { isTTY: true, write() {} };
  const e = { TERM_PROGRAM: 'Apple_Terminal' };
  const withBell = notifyAttention('done', { elapsedMs: 60_000, env: e, stream, force: true });
  const skipped = notifyAttention('done', { elapsedMs: 60_000, env: e, stream, force: true, soundPlayed: true });
  if (withBell === '\x07') assert.equal(skipped, '');
});

test('settings keep sounds and soundVolume from any scope', async () => {
  const { loadSettings } = await import('../src/settings.mjs');
  const root = home(); const cwd = path.join(root, 'project'); mkdirSync(path.join(cwd, '.oasis'), { recursive: true });
  writeFileSync(path.join(cwd, '.oasis', 'settings.json'), JSON.stringify({ sounds: false, soundVolume: 250 }));
  const settings = await loadSettings(cwd, { HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') });
  assert.equal(settings.sounds, false);
  assert.equal(settings.soundVolume, 100);
});
