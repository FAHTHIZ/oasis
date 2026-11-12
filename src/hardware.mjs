// Hardware-aware setup: look at this computer (OS, CPU, memory, GPU) and the
// model servers already running on it, then recommend the best way to run
// OASIS here. Used by `oasis setup --auto`, `oasis doctor`, the desktop first-run
// screen and the browser setup wizard, so every surface gives the same advice.
//
// Detection is read-only and bounded: fixed loopback ports only, a short timeout
// per probe, and GPU tools are run without a shell. Nothing is installed or
// downloaded here.
import { BUILTIN_PROVIDERS } from './provider-registry.mjs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import fs from 'node:fs';

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

// GPUs with less dedicated memory than this (integrated graphics, which report
// a small carve-out) cannot hold a useful model; the CPU budget is better.
const MIN_GPU_GB = 2;

function gpuVendor(name, pciVendor = '') {
  const id = String(pciVendor).toLowerCase();
  if (id === '0x10de' || /nvidia|geforce|quadro|tesla|rtx/i.test(name)) return 'nvidia';
  if (id === '0x1002' || /\bamd\b|radeon|instinct/i.test(name)) return 'amd';
  if (id === '0x8086' || /intel|\barc\b/i.test(name)) return 'intel';
  return 'other';
}

// Linux amdgpu (and other DRM drivers that expose it) report dedicated VRAM in
// /sys/class/drm/cardN/device/mem_info_vram_total, in bytes. Read-only, no tools.
export function readLinuxDrmGpus({ root = '/sys/class/drm', readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const gpus = [];
  let entries = [];
  try { entries = readdir(root); } catch { return gpus; }
  for (const entry of entries) {
    if (!/^card\d+$/.test(String(entry))) continue;
    const dir = root + '/' + entry + '/device/';
    const read = (file) => { try { return String(readFile(dir + file, 'utf8')).trim(); } catch { return ''; } };
    const bytes = Number(read('mem_info_vram_total'));
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    const pci = read('vendor');
    const vendor = gpuVendor(read('product_name'), pci);
    const name = read('product_name') || (vendor === 'amd' ? 'AMD Radeon GPU' : vendor === 'intel' ? 'Intel GPU' : 'GPU');
    gpus.push({ vendor, name, vramGB: round1(bytes / 1024 ** 3) });
  }
  return gpus;
}

// Windows display adapters from the registry. Win32_VideoController.AdapterRAM
// is a 32-bit value that caps at 4 GB, so read HardwareInformation.qwMemorySize
// (a 64-bit byte count) and DriverDesc for each adapter subkey instead.
const WINDOWS_DISPLAY_CLASS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

export function parseWindowsDisplayAdapters(memoryText, nameText) {
  const blocks = (text, pattern) => {
    const map = new Map();
    let key = '';
    for (const line of String(text || '').split(/\r?\n/)) {
      if (/^HKEY_/i.test(line.trim())) { key = line.trim().toLowerCase(); continue; }
      const match = line.match(pattern);
      if (key && match) map.set(key, match[1].trim());
    }
    return map;
  };
  const memory = blocks(memoryText, /HardwareInformation\.qwMemorySize\s+REG_QWORD\s+(0x[0-9a-f]+|\d+)/i);
  const names = blocks(nameText, /DriverDesc\s+REG_SZ\s+(.+)$/i);
  const gpus = [];
  for (const [key, raw] of memory) {
    const bytes = Number(raw);
    const name = names.get(key) || 'GPU';
    if (!Number.isFinite(bytes) || bytes <= 0 || /basic display|remote display|virtual/i.test(name)) continue;
    gpus.push({ vendor: gpuVendor(name), name, vramGB: round1(bytes / 1024 ** 3) });
  }
  return gpus;
}

const ACCELERATOR = { nvidia: 'cuda', amd: 'rocm', intel: 'vulkan', other: 'vulkan' };

// Everything except the GPU query is synchronous and cheap.
export async function detectHardware({
  platform = process.platform, arch = process.arch,
  cpus = os.cpus(), totalmem = os.totalmem(), freemem = os.freemem(),
  env = process.env, exec = run, drm = {}
} = {}) {
  const memoryGB = round1(totalmem / 1024 ** 3);
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  let gpus = [];
  if (!appleSilicon && platform !== 'android' && !env.OASIS_SKIP_GPU_PROBE) {
    gpus = parseNvidiaSmi(await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']));
    // nvidia-smi is authoritative for NVIDIA cards; add AMD and Intel ones from the OS.
    let others = [];
    if (platform === 'linux') others = readLinuxDrmGpus(drm);
    else if (platform === 'win32') {
      const [memoryText, nameText] = await Promise.all([
        exec('reg', ['query', WINDOWS_DISPLAY_CLASS, '/s', '/v', 'HardwareInformation.qwMemorySize']),
        exec('reg', ['query', WINDOWS_DISPLAY_CLASS, '/s', '/v', 'DriverDesc'])
      ]);
      others = parseWindowsDisplayAdapters(memoryText, nameText);
    }
    gpus = gpus.concat(others.filter((gpu) => gpu.vendor !== 'nvidia' || !gpus.length));
  }
  gpus = gpus.filter((gpu) => gpu.vramGB >= MIN_GPU_GB);
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
    accelerator: appleSilicon ? 'metal' : best ? (ACCELERATOR[best.vendor] || 'vulkan') : 'cpu',
    termux
  };
}

// Memory a local model can realistically use on this machine, in GB.
export function modelMemoryBudget(hw) {
  if (!hw) return 0;
  if (hw.gpu && hw.gpu.vramGB) return round1(hw.gpu.vramGB * 0.9);
  // Unified memory: macOS lets the GPU use roughly two thirds of RAM by default.
  if (hw.appleSilicon) return round1(hw.memoryGB * 0.65);
  // CPU-only: keep ~4.5 GB for the OS, editor and browser, and never plan on
  // more than 60% of RAM. An 8 GB laptop gets ~3.3 GB (enough for the 4b model);
  // 16 GB gets ~9.6 GB (qwen3:8b with room for its context).
  return round1(Math.max(0, Math.min(hw.memoryGB - 4.5, hw.memoryGB * 0.6)));
}

// Recommended local models by memory budget. Sizes are typical 4-bit downloads.
const LOCAL_MODEL_TIERS = [
  { minGB: 48, model: 'gpt-oss:120b', sizeGB: 65, contextWindow: 65536, label: 'large open model' },
  { minGB: 20, model: 'qwen3-coder:30b', sizeGB: 19, contextWindow: 65536, label: 'strong coding model' },
  { minGB: 13, model: 'gpt-oss:20b', sizeGB: 14, contextWindow: 32768, label: 'capable all-rounder' },
  { minGB: 9, model: 'qwen3:14b', sizeGB: 9.3, contextWindow: 32768, label: 'mid-size model' },
  { minGB: 5.5, model: 'qwen3:8b', sizeGB: 5.2, contextWindow: 16384, label: 'compact model' },
  // The plain qwen3:4b tag is a thinking model: on a 2-CPU machine it spent a
  // 512-token budget reasoning without calling the connection-test tool (91 s).
  // The 2507 instruct build answered the same test with a tool call in 17 s cold.
  { minGB: 3, model: 'qwen3:4b-instruct-2507-q4_K_M', sizeGB: 2.5, contextWindow: 16384, label: 'small model' }
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

// Local servers to look for, from provider-registry.mjs. Probe paths are
// relative to the server origin (Ollama's native /api/tags lists its models).
export const LOCAL_SERVERS = Object.values(BUILTIN_PROVIDERS).filter((entry) => entry.local).map((entry) => ({
  id: entry.id, name: entry.label, baseURL: entry.baseURL, probe: new URL(entry.baseURL).origin + entry.local.probe, kind: entry.local.kind
}));

// Probe the fixed loopback ports of common model servers in parallel.
export async function discoverLocalServers({ fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, servers = LOCAL_SERVERS } = {}) {
  const results = await Promise.all(servers.map(async (server) => {
    try {
      const response = await fetchImpl(server.probe, { method: 'GET', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      // A server that wants a key still counts as running.
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

  const withModels = servers.filter((s) => s.running && s.models && s.models.length);
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
    if (tier && budgetGB >= 5.5) {
      primary = {
        route: 'local-install', server: 'ollama', serverName: 'Ollama', protocol: 'openai-compatible',
        baseURL: BUILTIN_PROVIDERS.ollama.baseURL, model: tier.model, contextWindow: tier.contextWindow,
        install: { url: 'https://ollama.com/download', command: 'ollama pull ' + tier.model, downloadGB: tier.sizeGB },
        reason: 'This computer can run ' + tier.model + ' (' + tier.label + ', about ' + tier.sizeGB + ' GB) privately. Install Ollama, then pull the model.'
      };
    } else {
      primary = {
        route: 'cloud', protocol: BUILTIN_PROVIDERS.openrouter.protocol, baseURL: BUILTIN_PROVIDERS.openrouter.baseURL, model: '',
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
  if ((hw.accelerator === 'rocm' || hw.accelerator === 'vulkan') && primary.route.startsWith('local')) notes.push('Ollama runs on ' + (hw.accelerator === 'rocm' ? 'AMD GPUs through ROCm or Vulkan' : 'this GPU through Vulkan') + ' only for supported cards; after the first reply, `ollama ps` shows whether the model is on the GPU or fell back to the CPU.');
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
  // Every field is optional so a partial or older profile never prints "undefined".
  const h = hw || {};
  const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' }[h.os || h.platform] || h.os || h.platform || '';
  const parts = [];
  const system = [osName, h.arch].filter(Boolean).join(' ');
  if (system) parts.push(system);
  if (Number(h.cores) > 0) parts.push(h.cores + ' CPU cores');
  if (Number(h.memoryGB) > 0) parts.push(h.memoryGB + ' GB memory');
  if (h.appleSilicon) parts.push('Apple Silicon GPU (shared memory)');
  else if (h.gpu && h.gpu.name) parts.push(h.gpu.name + (Number(h.gpu.vramGB) > 0 ? ' (' + h.gpu.vramGB + ' GB)' : ''));
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
