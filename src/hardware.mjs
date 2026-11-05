// Hardware-aware setup: look at this computer (OS, CPU, memory, GPU) and the
// model servers already running on it, then recommend the best way to run
// OASIS here. Used by `oasis setup --auto`, `oasis doctor`, the desktop first-run
// screen and the browser setup wizard, so every surface gives the same advice.
//
// Detection is read-only and bounded: fixed loopback ports only, a short timeout
// per probe, and GPU tools are run without a shell. Nothing is installed or
// downloaded here.
import os from 'node:os';
import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 1200;
const GPU_TIMEOUT_MS = 2500;

function run(command, args, timeout = GPU_TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

const round1 = (value) => Math.round(value * 10) / 10;

export function parseNvidiaSmi(text) {
  const gpus = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [name, memory] = line.split(',').map((part) => part && part.trim());
    const mib = Number(memory);
    if (name && Number.isFinite(mib) && mib > 0) gpus.push({ vendor: 'nvidia', name, vramGB: round1(mib / 1024) });
  }
  return gpus;
}

// Everything except the GPU query is synchronous and cheap.
export async function detectHardware({
  platform = process.platform, arch = process.arch,
  cpus = os.cpus(), totalmem = os.totalmem(), freemem = os.freemem(),
  env = process.env, exec = run
} = {}) {
  const memoryGB = round1(totalmem / 1024 ** 3);
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  let gpus = [];
  if (!appleSilicon && platform !== 'android' && !env.OASIS_SKIP_GPU_PROBE) {
    gpus = parseNvidiaSmi(await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']));
  }
  const termux = Boolean(env.TERMUX_VERSION || String(env.PREFIX || '').includes('com.termux'));
  const best = gpus.slice().sort((a, b) => b.vramGB - a.vramGB)[0] || null;
  return {
    os: termux ? 'android' : platform,
    platform, arch,
    osRelease: os.release(),
    cpuModel: String(cpus && cpus[0] && cpus[0].model || '').trim(),
    cores: Array.isArray(cpus) ? cpus.length : 0,
    memoryGB,
    freeMemoryGB: round1(freemem / 1024 ** 3),
    appleSilicon,
    gpu: best,
    gpuCount: gpus.length,
    accelerator: appleSilicon ? 'metal' : best ? 'cuda' : 'cpu',
    termux
  };
}

// Memory a local model can realistically use on this machine, in GB.
export function modelMemoryBudget(hw) {
  if (!hw) return 0;
  if (hw.gpu && hw.gpu.vramGB) return round1(hw.gpu.vramGB * 0.9);
  // Unified memory: macOS lets the GPU use roughly two thirds of RAM by default.
  if (hw.appleSilicon) return round1(hw.memoryGB * 0.65);
  // CPU-only: leave room for the OS, the editor and the browser.
  return round1(Math.max(0, hw.memoryGB - 4) * 0.5);
}

// Recommended local models by memory budget. Sizes are typical 4-bit downloads.
export const LOCAL_MODEL_TIERS = [
  { minGB: 48, model: 'gpt-oss:120b', sizeGB: 65, contextWindow: 65536, label: 'large open model' },
  { minGB: 20, model: 'qwen3-coder:30b', sizeGB: 19, contextWindow: 65536, label: 'strong coding model' },
  { minGB: 13, model: 'gpt-oss:20b', sizeGB: 14, contextWindow: 32768, label: 'capable all-rounder' },
  { minGB: 9, model: 'qwen3:14b', sizeGB: 9.3, contextWindow: 32768, label: 'mid-size model' },
  { minGB: 5.5, model: 'qwen3:8b', sizeGB: 5.2, contextWindow: 16384, label: 'compact model' },
  { minGB: 3, model: 'qwen3:4b', sizeGB: 2.5, contextWindow: 16384, label: 'small model' }
];

export function localModelTier(budgetGB) {
  // gpt-oss:120b needs ~65 GB: only offer it when that much is really available.
  return LOCAL_MODEL_TIERS.find((tier) => budgetGB >= Math.max(tier.minGB, tier.sizeGB * 1.1)) || null;
}

// Rough parameter count (billions) from a model tag like "qwen2.5-coder:14b" or
// "llama3.1:8b-instruct-q4_K_M". Mixture-of-experts tags like "30b-a3b" use the
// total, because all experts must fit in memory.
export function modelParamsB(name) {
  const text = String(name || '').toLowerCase();
  const match = text.match(/(?:^|[:\-_/ ])(\d+(?:\.\d+)?)\s*b(?![a-z])/) || text.match(/(\d+(?:\.\d+)?)b(?:-|$)/);
  return match ? Number(match[1]) : null;
}

const TOOL_CAPABLE = /qwen3|qwen2\.5|coder|gpt-oss|devstral|llama3\.[1-9]|llama-?4|mistral|mixtral|granite|deepseek|command-r|hermes|glm|kimi|phi-?4|gemma3/;

// Pick the best already-installed model that fits in memory: prefer families that
// handle tool calls well, then the largest that fits.
export function pickInstalledModel(models, budgetGB, { loaded = false } = {}) {
  const scored = [];
  for (const name of Array.isArray(models) ? models : []) {
    const lower = String(name).toLowerCase();
    if (/embed|bge|nomic|minilm|rerank|whisper|clip|llava|vision-only/.test(lower)) continue;
    const params = modelParamsB(lower);
    const needGB = params ? params * 0.62 + 1 : null;
    // A model a server has already loaded evidently fits; installed-only models must.
    const fits = loaded || needGB === null ? true : needGB <= Math.max(budgetGB, 2.5);
    if (!fits) continue;
    scored.push({ name, params, score: (TOOL_CAPABLE.test(lower) ? 1000 : 0) + (/coder|devstral/.test(lower) ? 50 : 0) + (params || 4) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

export const LOCAL_SERVERS = [
  { id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', probe: 'http://127.0.0.1:11434/api/tags', kind: 'ollama' },
  { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', probe: 'http://127.0.0.1:1234/v1/models', kind: 'openai' },
  { id: 'llamacpp', name: 'llama.cpp server', baseURL: 'http://127.0.0.1:8080/v1', probe: 'http://127.0.0.1:8080/v1/models', kind: 'openai' },
  { id: 'jan', name: 'Jan', baseURL: 'http://127.0.0.1:1337/v1', probe: 'http://127.0.0.1:1337/v1/models', kind: 'openai' },
  { id: 'vllm', name: 'vLLM', baseURL: 'http://127.0.0.1:8000/v1', probe: 'http://127.0.0.1:8000/v1/models', kind: 'openai' },
  { id: 'omniroute', name: 'OmniRoute gateway', baseURL: 'http://127.0.0.1:20128/v1', probe: 'http://127.0.0.1:20128/v1/models', kind: 'openai', gateway: true }
];

// Probe the fixed loopback ports of common model servers in parallel.
export async function discoverLocalServers({ fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, servers = LOCAL_SERVERS } = {}) {
  const results = await Promise.all(servers.map(async (server) => {
    try {
      const response = await fetchImpl(server.probe, { method: 'GET', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      // A gateway that wants a key still counts as running.
      if (response.status === 401 || response.status === 403) return { ...server, running: true, models: [], needsKey: true };
      if (!response.ok) return null;
      const payload = await response.json().catch(() => ({}));
      const list = server.kind === 'ollama'
        ? (payload && Array.isArray(payload.models) ? payload.models.map((m) => m && (m.name || m.model)) : [])
        : (payload && Array.isArray(payload.data) ? payload.data.map((m) => m && m.id) : []);
      return { ...server, running: true, models: [...new Set(list.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 100) };
    } catch { return null; }
  }));
  return results.filter(Boolean).map(({ probe, kind, ...rest }) => rest);
}

// The single best route for this computer, plus alternatives. `configured`
// describes the current provider so an existing setup is never second-guessed.
export function recommendSetup(hw, servers = [], { configured = false } = {}) {
  const budgetGB = modelMemoryBudget(hw);
  const tier = localModelTier(budgetGB);
  const notes = [];
  const alternatives = [];
  let primary;

  const withModels = servers.filter((s) => s.running && s.models && s.models.length && !s.gateway);
  const ranked = withModels
    .map((server) => ({ server, pick: pickInstalledModel(server.models, budgetGB, { loaded: server.id !== 'ollama' }) }))
    .filter((entry) => entry.pick)
    .sort((a, b) => b.pick.score - a.pick.score);

  if (ranked.length) {
    const { server, pick } = ranked[0];
    const params = pick.params || 8;
    primary = {
      route: 'local', server: server.id, serverName: server.name,
      protocol: 'openai-compatible', baseURL: server.baseURL, model: pick.name,
      contextWindow: params <= 9 ? 16384 : params <= 20 ? 32768 : 65536,
      reason: server.name + ' is running with ' + pick.name + ', which fits in this computer\'s ' + budgetGB + ' GB model memory.'
    };
  } else {
    const gateway = servers.find((s) => s.gateway && s.running);
    if (gateway) {
      primary = { route: 'gateway', server: gateway.id, serverName: gateway.name, protocol: 'openai-compatible', baseURL: gateway.baseURL, model: 'auto', reason: 'OmniRoute is running locally and can route to free and paid models.' };
    } else if (tier && budgetGB >= 5.5) {
      primary = {
        route: 'local-install', server: 'ollama', serverName: 'Ollama', protocol: 'openai-compatible',
        baseURL: 'http://127.0.0.1:11434/v1', model: tier.model, contextWindow: tier.contextWindow,
        install: { url: 'https://ollama.com/download', command: 'ollama pull ' + tier.model, downloadGB: tier.sizeGB },
        reason: 'This computer can run ' + tier.model + ' (' + tier.label + ', about ' + tier.sizeGB + ' GB) privately. Install Ollama, then pull the model.'
      };
    } else {
      primary = {
        route: 'cloud', protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '',
        reason: budgetGB < 3
          ? 'This device has about ' + hw.memoryGB + ' GB of memory, which is too little for a useful local model. A hosted model will be much faster and more capable.'
          : 'A hosted model is recommended here; a local model that fits would be slow and weak at multi-step coding.'
      };
    }
  }

  if (primary.route !== 'cloud') alternatives.push({ route: 'cloud', reason: 'Hosted models (OpenAI, Anthropic, Gemini, OpenRouter) are the most capable for large changes.' });
  if (primary.route === 'cloud' && tier) alternatives.push({ route: 'local-install', model: tier.model, reason: 'For private use, ' + tier.model + ' fits, but expect slower, simpler results.' });
  if (primary.route === 'local' && tier && primary.model !== tier.model && (modelParamsB(primary.model) || 0) < (modelParamsB(tier.model) || 0)) {
    alternatives.push({ route: 'local-install', model: tier.model, reason: 'This computer could also run the larger ' + tier.model + ' (ollama pull ' + tier.model + ').' });
  }

  if (hw.accelerator === 'cpu' && primary.route.startsWith('local')) notes.push('No supported GPU was found, so a local model runs on the CPU. Expect a few tokens per second; keep tasks small.');
  if (hw.termux) notes.push('On Android, run the model on another computer or use a hosted model; phone CPUs are too slow for agent work.');
  if (hw.cores && hw.cores <= 4) notes.push('With ' + hw.cores + ' CPU cores, run one agent at a time.');
  if (configured) notes.push('A model provider is already configured; this is only a suggestion.');

  return {
    hardware: hw, budgetGB, primary, alternatives, notes,
    // Only settings OASIS actually reads: the context window drives the
    // small-context tool profile for small local models.
    settings: primary.contextWindow ? { contextWindow: primary.contextWindow } : {}
  };
}

export function describeHardware(hw) {
  const parts = [
    ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' }[hw.os] || hw.os) + ' ' + hw.arch,
    hw.cores + ' CPU cores',
    hw.memoryGB + ' GB memory'
  ];
  if (hw.appleSilicon) parts.push('Apple Silicon GPU (shared memory)');
  else if (hw.gpu) parts.push(hw.gpu.name + ' (' + hw.gpu.vramGB + ' GB)');
  else parts.push('no supported GPU');
  return parts.join(' · ');
}

export function describeRecommendation(rec) {
  const lines = ['This computer: ' + describeHardware(rec.hardware), 'Model memory budget: about ' + rec.budgetGB + ' GB', 'Recommended: ' + rec.primary.reason];
  if (rec.primary.install) lines.push('  1. Install Ollama: ' + rec.primary.install.url, '  2. Run: ' + rec.primary.install.command, '  3. Run: oasis setup --auto');
  for (const alt of rec.alternatives) lines.push('Also possible: ' + alt.reason);
  for (const note of rec.notes) lines.push('Note: ' + note);
  return lines.join('\n');
}

export async function profileThisComputer(options = {}) {
  const [hardware, servers] = await Promise.all([detectHardware(options), discoverLocalServers(options)]);
  return recommendSetup(hardware, servers, options);
}
