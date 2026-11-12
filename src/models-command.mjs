// `oasis models`: the models the configured provider serves, with context
// window, price and capabilities from the models.dev catalog where known.
//
//   oasis models                 table of every model (current one marked *)
//   oasis models sonnet          only ids containing "sonnet"
//   oasis models --json          machine-readable list
//   oasis models --refresh       skip the five-minute cache

import { loadConfig } from './config.mjs';
import { listProviderModels } from './provider-models.mjs';
import { findCatalogModel, catalogContextWindow } from './model-catalog.mjs';
import { modelAllowed } from './model-aliases.mjs';

const USAGE = 'Usage: oasis models [filter] [--json] [--refresh]';

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

export async function modelsCommand(args = [], { root = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl, configOverride } = {}) {
  if (args.includes('--help') || args.includes('-h')) { stdout.write(USAGE + '\n'); return 0; }
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
