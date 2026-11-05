import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRecommendation, detectHardware, discoverLocalServers, localModelTier, modelMemoryBudget,
  modelParamsB, parseNvidiaSmi, pickInstalledModel, recommendSetup
} from '../src/hardware.mjs';

const GB = 1024 ** 3;
const cpus = (n) => Array.from({ length: n }, () => ({ model: 'Test CPU' }));

test('nvidia-smi output is parsed into GPUs with VRAM in GB', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA RTX A2000, 6138\n'), [
    { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramGB: 24 },
    { vendor: 'nvidia', name: 'NVIDIA RTX A2000', vramGB: 6 }
  ]);
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi('garbage'), []);
});

test('hardware detection: Apple Silicon, NVIDIA, CPU-only and Termux', async () => {
  const mac = await detectHardware({ platform: 'darwin', arch: 'arm64', cpus: cpus(10), totalmem: 32 * GB, freemem: 8 * GB, exec: async () => { throw new Error('no GPU probe on macOS'); } });
  assert.equal(mac.accelerator, 'metal');
  assert.equal(mac.memoryGB, 32);
  const pc = await detectHardware({ platform: 'win32', arch: 'x64', cpus: cpus(16), totalmem: 64 * GB, freemem: 30 * GB, env: {}, exec: async () => 'NVIDIA GeForce RTX 4070, 12282\n' });
  assert.equal(pc.accelerator, 'cuda');
  assert.equal(pc.gpu.vramGB, 12);
  const laptop = await detectHardware({ platform: 'linux', arch: 'x64', cpus: cpus(4), totalmem: 8 * GB, freemem: 2 * GB, env: {}, exec: async () => '' });
  assert.equal(laptop.accelerator, 'cpu');
  const phone = await detectHardware({ platform: 'linux', arch: 'arm64', cpus: cpus(8), totalmem: 6 * GB, freemem: 2 * GB, env: { TERMUX_VERSION: '0.118' }, exec: async () => '' });
  assert.equal(phone.os, 'android');
  assert.equal(phone.termux, true);
});

test('model memory budgets follow the accelerator', () => {
  assert.equal(modelMemoryBudget({ gpu: { vramGB: 24 } }), 21.6);
  assert.equal(modelMemoryBudget({ appleSilicon: true, memoryGB: 32 }), 20.8);
  assert.equal(modelMemoryBudget({ memoryGB: 16 }), 6);
  assert.equal(modelMemoryBudget({ memoryGB: 4 }), 0);
});

test('tiers pick the largest model that really fits', () => {
  assert.equal(localModelTier(2), null);
  assert.equal(localModelTier(3.2).model, 'qwen3:4b');
  assert.equal(localModelTier(6).model, 'qwen3:8b');
  assert.equal(localModelTier(21.6).model, 'qwen3-coder:30b');
  assert.equal(localModelTier(50).model, 'qwen3-coder:30b', '120b needs ~72 GB, so 50 GB stays on the 30b');
  assert.equal(localModelTier(80).model, 'gpt-oss:120b');
});

test('parameter counts are read from common model tags', () => {
  assert.equal(modelParamsB('qwen2.5-coder:14b'), 14);
  assert.equal(modelParamsB('llama3.1:8b-instruct-q4_K_M'), 8);
  assert.equal(modelParamsB('qwen3-coder:30b-a3b'), 30);
  assert.equal(modelParamsB('qwen3:4b'), 4);
  assert.equal(modelParamsB('gemma3:1b'), 1);
  assert.equal(modelParamsB('mistral'), null);
});

test('installed-model choice prefers tool-capable families and skips what will not fit', () => {
  assert.equal(pickInstalledModel(['nomic-embed-text', 'llama2:7b', 'qwen3:8b', 'qwen3:32b'], 8).name, 'qwen3:8b');
  assert.equal(pickInstalledModel(['qwen2.5-coder:7b', 'qwen3:8b'], 8).name, 'qwen2.5-coder:7b', 'coding models get a bonus');
  assert.equal(pickInstalledModel(['llama3.3:70b'], 8), null);
  assert.equal(pickInstalledModel(['nomic-embed-text'], 8), null);
});

test('a running server with a fitting model is recommended first', () => {
  const hw = { os: 'darwin', arch: 'arm64', appleSilicon: true, memoryGB: 32, cores: 10, accelerator: 'metal' };
  const rec = recommendSetup(hw, [{ id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', running: true, models: ['qwen3:8b', 'nomic-embed-text'] }]);
  assert.equal(rec.primary.route, 'local');
  assert.equal(rec.primary.model, 'qwen3:8b');
  assert.equal(rec.primary.contextWindow, 16384);
  assert.deepEqual(rec.settings, { contextWindow: 16384 });
  assert.ok(rec.alternatives.some((alt) => alt.model === 'gpt-oss:20b'), 'a bigger model that fits is offered');
});

test('without a server, capable machines get an install plan and small devices get a hosted model', () => {
  const desktop = recommendSetup({ os: 'win32', arch: 'x64', memoryGB: 64, cores: 16, gpu: { name: 'RTX 4090', vramGB: 24 }, accelerator: 'cuda' }, []);
  assert.equal(desktop.primary.route, 'local-install');
  assert.equal(desktop.primary.model, 'qwen3-coder:30b');
  assert.equal(desktop.primary.install.command, 'ollama pull qwen3-coder:30b');
  const thin = recommendSetup({ os: 'linux', arch: 'x64', memoryGB: 8, cores: 4, accelerator: 'cpu' }, []);
  assert.equal(thin.primary.route, 'cloud');
  assert.ok(thin.notes.some((n) => /4 CPU cores/.test(n)));
  const phone = recommendSetup({ os: 'android', arch: 'arm64', memoryGB: 6, cores: 8, accelerator: 'cpu', termux: true }, []);
  assert.equal(phone.primary.route, 'cloud');
  assert.ok(phone.notes.some((n) => /Android/.test(n)));
  const gateway = recommendSetup({ os: 'linux', arch: 'x64', memoryGB: 8, cores: 4, accelerator: 'cpu' }, [{ id: 'omniroute', name: 'OmniRoute gateway', baseURL: 'http://127.0.0.1:20128/v1', running: true, models: [], gateway: true }]);
  assert.equal(gateway.primary.route, 'gateway');
  assert.match(describeRecommendation(desktop), /Install Ollama/);
});

test('local server discovery probes fixed loopback ports and reads both API shapes', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'http://127.0.0.1:11434/api/tags') return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'qwen3:8b' }] }) };
    if (url === 'http://127.0.0.1:1234/v1/models') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen/qwen3-14b' }] }) };
    if (url === 'http://127.0.0.1:20128/v1/models') return { ok: false, status: 401, json: async () => ({}) };
    throw new Error('ECONNREFUSED');
  };
  const servers = await discoverLocalServers({ fetchImpl });
  assert.ok(seen.every((url) => url.startsWith('http://127.0.0.1:')), 'only loopback is probed');
  assert.deepEqual(servers.map((s) => s.id), ['ollama', 'lmstudio', 'omniroute']);
  assert.deepEqual(servers[0].models, ['qwen3:8b']);
  assert.equal(servers[2].needsKey, true);
  assert.ok(!('probe' in servers[0]));
});

test('a model already loaded by llama.cpp or LM Studio is trusted to fit', () => {
  const hw = { os: 'linux', arch: 'x64', memoryGB: 7.8, cores: 2, accelerator: 'cpu' };
  const rec = recommendSetup(hw, [{ id: 'llamacpp', name: 'llama.cpp server', baseURL: 'http://127.0.0.1:8080/v1', running: true, models: ['qwen3-4b-2507.gguf'] }]);
  assert.equal(rec.primary.route, 'local');
  assert.equal(rec.primary.model, 'qwen3-4b-2507.gguf');
  assert.ok(rec.notes.some((n) => /CPU/.test(n)));
  const ollamaOnly = recommendSetup(hw, [{ id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', running: true, models: ['qwen3:14b'] }]);
  assert.equal(ollamaOnly.primary.route, 'cloud', 'an installed-but-too-big Ollama model is not recommended');
});
