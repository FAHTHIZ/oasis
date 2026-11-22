// `oasis models`: the models the configured provider serves, with context
// window, price and capabilities from the models.dev catalog where known.
//
//   oasis models                 table of every model (current one marked *)
//   oasis models sonnet          only ids containing "sonnet"
//   oasis models --json          machine-readable list
//   oasis models --refresh       skip the five-minute cache
//   oasis models free            free models that can drive an agent right now
//                                (--apply [N] adds the best N to the fallback chain)

import { loadConfig } from './config.mjs';
import { listProviderModels } from './provider-models.mjs';
import { findCatalogModel, catalogContextWindow } from './model-catalog.mjs';
import { modelAllowed } from './model-aliases.mjs';

const USAGE = 'Usage: oasis models [filter] [--json] [--refresh]\n       oasis models free [--json] [--apply [N]] [--cloud-only|--local-only]';

function compactTokens(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

function price(value) {
  if (typeof value !== 'number') return '';
  return '$' + (value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(2).replace(/\.?0+$/, '') : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
}

/** Describe one model id with catalog facts (all optional). */
function describeModel(id, config = {}, env = process.env) {
  const options = { baseURL: config.baseURL, provider: config.catalogProvider, env };
  const entry = findCatalogModel(id, options);
  const out = { id };
  if (!entry) return out;
  const window = catalogContextWindow(id, options);
  if (window) out.contextWindow = window;
  if (entry.output) out.maxOutput = entry.output;
  if (entry.cost && typeof entry.cost.input === 'number') out.inputPerMTok = entry.cost.input;
  if (entry.cost && typeof entry.cost.output === 'number') out.outputPerMTok = entry.cost.output;
  if (typeof entry.toolCall === 'boolean') out.tools = entry.toolCall;
  if (typeof entry.image === 'boolean') out.images = entry.image;
  return out;
}

/** Plain-text table for the terminal. */
export function formatModelTable(rows, current) {
  const head = ['', 'MODEL', 'CONTEXT', 'IN $/M', 'OUT $/M', 'TOOLS', 'IMAGES'];
  const body = rows.map((row) => [
    row.id === current ? '*' : '',
    row.id,
    compactTokens(row.contextWindow),
    price(row.inputPerMTok),
    price(row.outputPerMTok),
    row.tools === true ? 'yes' : row.tools === false ? 'no' : '',
    row.images === true ? 'yes' : row.images === false ? 'no' : ''
  ]);
  const widths = head.map((cell, i) => Math.max(cell.length, ...body.map((line) => line[i].length)));
  const render = (line) => line.map((cell, i) => i === line.length - 1 ? cell : cell.padEnd(widths[i])).join('  ').trimEnd();
  return [render(head), ...body.map(render)].join('\n');
}

function compactContext(n) {
  return n ? compactTokens(n) : '?';
}

async function freeModelsCommand(args, { root, env, stdout, stderr, fetchImpl }) {
  const known = ['--json', '--apply', '--cloud-only', '--local-only'];
  const applyAt = args.indexOf('--apply');
  const countArg = applyAt >= 0 && /^\d+$/.test(args[applyAt + 1] || '') ? args[applyAt + 1] : null;
  const unknown = args.find((arg, i) => !known.includes(arg) && !(countArg && i === applyAt + 1));
  if (unknown) { stderr.write('Unknown option ' + unknown + '. ' + USAGE + '\n'); return 2; }
  const { discoverFreeModels, withFreeFallbacks } = await import('./free-models.mjs');
  const found = await discoverFreeModels({ ...(fetchImpl ? { fetchImpl } : {}), local: !args.includes('--cloud-only'), cloud: !args.includes('--local-only') });
  const openrouterKey = Boolean(env.OPENROUTER_API_KEY);
  let applied = null;
  if (applyAt >= 0 && found.models.length) {
    const count = Math.max(1, Math.min(10, Number(countArg) || 3));
    const { updateUserSettings } = await import('./settings.mjs');
    await updateUserSettings((settings) => {
      applied = withFreeFallbacks(settings.fallbackModel, found.models, count);
      if (applied.added.length) settings.fallbackModel = applied.chain.join(',');
      return settings;
    }, env);
  }
  if (args.includes('--json')) {
    stdout.write(JSON.stringify({ checkedAt: found.checkedAt, models: found.models, errors: found.errors, ollama: found.ollama, ...(applied ? { applied } : {}) }, null, 2) + '\n');
    return found.models.length ? 0 : 1;
  }
  if (!found.models.length) {
    stderr.write('No free model that supports tool calls was found' + (found.errors.length ? ' (' + found.errors.join('; ') + ')' : '') + '.' + (found.ollama ? '' : ' Installing Ollama with a tool-capable model (for example qwen3) gives you one that never runs out.') + '\n');
    return 1;
  }
  const head = ['#', 'FALLBACK ENTRY', 'CONTEXT', 'SIZE', 'NOTES'];
  const body = found.models.slice(0, 25).map((model, i) => [String(i + 1), model.spec, compactContext(model.context), model.billions ? model.billions + 'B' : '?', [
    model.source === 'ollama' ? 'local' : 'cloud, needs OPENROUTER_API_KEY',
    model.router ? 'routes to any free model' : '',
    model.vision ? 'vision' : '', model.reasoning ? 'reasoning' : '',
    model.source === 'ollama' && !model.toolsReported ? 'tool support not reported' : '',
    model.expires ? 'expires ' + model.expires.slice(0, 10) : ''
  ].filter(Boolean).join(', ')]);
  const widths = head.map((cell, i) => Math.max(cell.length, ...body.map((line) => line[i].length)));
  const render = (line) => line.map((cell, i) => i === line.length - 1 ? cell : cell.padEnd(widths[i])).join('  ').trimEnd();
  stdout.write([render(head), ...body.map(render)].join('\n') + '\n\n');
  const notes = [found.models.length + ' free model' + (found.models.length === 1 ? '' : 's') + ' with tool calling, best for agent work first (checked ' + found.checkedAt.slice(0, 16).replace('T', ' ') + ' UTC).'];
  if (found.errors.length) notes.push('Not checked: ' + found.errors.join('; ') + '.');
  if (!found.ollama && !args.includes('--cloud-only')) notes.push('Ollama is not running here; a local model has no daily limit and keeps your data on this computer.');
  if (!openrouterKey && found.models.some((model) => model.source === 'openrouter')) notes.push('OpenRouter free models need a free account key in OPENROUTER_API_KEY (openrouter.ai/keys); free use is limited per day.');
  if (applied) notes.push(applied.added.length ? 'Added to your fallback chain (settings fallbackModel): ' + applied.added.join(', ') + '.' : 'Your fallback chain already has these models.');
  else notes.push('oasis models free --apply adds the best three to your fallback chain; --zero-budget then uses only free routes.');
  stdout.write(notes.join('\n') + '\n');
  return 0;
}

export async function modelsCommand(args = [], { root = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl, configOverride } = {}) {
  if (args.includes('--help') || args.includes('-h')) { stdout.write(USAGE + '\n'); return 0; }
  if (args[0] === 'free') return await freeModelsCommand(args.slice(1), { root, env, stdout, stderr, fetchImpl });
  const unknown = args.find((arg) => arg.startsWith('-') && !['--json', '--refresh'].includes(arg));
  if (unknown) { stderr.write('Unknown option ' + unknown + '. ' + USAGE + '\n'); return 2; }
  const json = args.includes('--json');
  const filter = args.filter((arg) => !arg.startsWith('-')).join(' ').trim().toLowerCase();
  let config;
  try { config = configOverride || await loadConfig(); }
  catch (error) { stderr.write('No model provider is configured (' + String(error && error.message || error) + '). Run oasis setup or oasis connect.\n'); return 1; }
  let allowed = [];
  let policy = {};
  try {
    const { loadSettings } = await import('./settings.mjs');
    const loaded = await loadSettings(root, { env });
    allowed = loaded.availableModels || [];
    policy = { denied: loaded.deniedModels || [], match: loaded.availableModelsMatch || 'prefix' };
  } catch { allowed = []; }
  const current = config.model || '';
  if (config.configured === false) {
    const reason = 'No model provider is configured. Run oasis setup first.';
    if (json) stdout.write(JSON.stringify({ current: null, models: null, reason }, null, 2) + '\n');
    else stderr.write(reason + '\n');
    return 1;
  }
  const listed = await listProviderModels(config, { env, cwd: root, refresh: args.includes('--refresh'), ...(fetchImpl ? { fetchImpl } : {}) });
  if (!listed.models) {
    if (json) stdout.write(JSON.stringify({ current, models: null, reason: listed.reason }, null, 2) + '\n');
    else stderr.write((current ? 'Current model: ' + current + '\n' : '') + listed.reason + '\n');
    return 1;
  }
  const usable = listed.models.filter((id) => modelAllowed(id, allowed, { env, protocol: config.protocol, ...policy }));
  const hidden = listed.models.length - usable.length;
  const rows = usable.filter((id) => !filter || id.toLowerCase().includes(filter)).map((id) => describeModel(id, config, env));
  if (json) {
    stdout.write(JSON.stringify({ current, endpoint: listed.endpoint, hiddenByPolicy: hidden, models: rows }, null, 2) + '\n');
    return 0;
  }
  if (!rows.length) {
    stdout.write((filter ? 'No models match "' + filter + '".' : 'The provider lists no models.') + (current ? ' Current model: ' + current + '.' : '') + '\n');
    return filter ? 1 : 0;
  }
  stdout.write(formatModelTable(rows, current) + '\n\n');
  const notes = [rows.length + ' of ' + listed.models.length + ' model' + (listed.models.length === 1 ? '' : 's') + ' from ' + new URL(listed.endpoint).host];
  if (hidden) notes.push(hidden + ' hidden by availableModels');
  if (current) notes.push('current: ' + current);
  stdout.write(notes.join(' · ') + '\nSwitch with oasis --model <id>, or /model <id> in a session.\n');
  return 0;
}
