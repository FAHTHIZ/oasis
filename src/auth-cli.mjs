// `oasis auth status|login|logout` (Claude Code's `claude auth`), `oasis setup-token`,
// and `oasis agents --json`. Credentials are never printed.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, getConfigDirectory, getConfigPath, getProviderSummary } from './config.mjs';

const CLOUD = ['bedrock', 'vertex', 'foundry'];

function keySource(config, env) {
  if (CLOUD.includes(config.protocol)) return null;
  for (const name of ['OASIS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OASIS_LOCAL_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY']) {
    if (env[name] && config.apiKey === env[name]) return name;
  }
  return config.apiKey ? 'config' : null;
}

// Claude's authMethod values are none | claude.ai | oauth_token | api_key | api_key_helper | third_party.
// OASIS adds "local" for loopback endpoints that need no key.
export async function authStatus(env = process.env) {
  let config;
  try { config = await loadConfig({ env }); } catch (error) {
    return { loggedIn: false, authMethod: 'none', error: error.message, configDirectory: getConfigDirectory(env) };
  }
  const summary = getProviderSummary(config);
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(config.baseURL || '');
  const authMethod = CLOUD.includes(config.protocol) ? (config.configured ? 'third_party' : 'none')
    : env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token'
    : config.apiKey ? 'api_key' : config.apiKeyHelper ? 'api_key_helper' : local ? 'local' : 'none';
  return {
    loggedIn: authMethod !== 'none',
    authMethod,
    apiProvider: CLOUD.includes(config.protocol) ? config.protocol : summary.provider,
    protocol: config.protocol,
    baseURL: config.baseURL,
    model: config.model,
    apiKeySource: keySource(config, env),
    authentication: summary.authentication,
    configDirectory: getConfigDirectory(env),
    configFile: config.configPath
  };
}

export function describeAuthStatus(status) {
  if (!status.loggedIn) return 'Not signed in to a model provider' + (status.error ? ': ' + status.error : '') + '.\nRun oasis auth login (or oasis setup) to connect one.';
  return [
    'Signed in: ' + status.authMethod.replace(/_/g, ' ') + (status.apiKeySource ? ' (' + status.apiKeySource + ')' : ''),
    'Provider: ' + status.apiProvider + ' (' + status.protocol + ')',
    'Model: ' + status.model,
    'Config: ' + status.configDirectory
  ].join('\n');
}

// Removes the stored key from config.json. Keys in environment variables stay (we say so).
export async function authLogout(env = process.env) {
  const file = getConfigPath(env);
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')); } catch { saved = null; }
  const had = Boolean(saved && saved.apiKey);
  if (had) { delete saved.apiKey; await writeFile(file, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }); }
  const envKeys = ['OASIS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((name) => env[name]);
  return { removed: had, file, envKeys };
}

// Non-interactive login: --api-key KEY [--protocol P] [--base-url URL] [--model M]. Writes config.json.
export async function authLoginWithKey(options, env = process.env) {
  const { saveConfig } = await import('./config.mjs');
  const current = await loadConfig({ env }).catch(() => ({}));
  const protocol = options.protocol || (options.console ? 'anthropic' : current.protocol) || 'anthropic';
  const sameProtocol = current.protocol === protocol;
  await saveConfig({
    ...(sameProtocol ? current : {}),
    protocol,
    baseURL: options.baseURL || (sameProtocol ? current.baseURL : undefined),
    model: options.model || (sameProtocol ? current.model : undefined),
    apiKey: options.apiKey
  }, { env });
  return authStatus({ ...env, OASIS_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
}

export function parseAuthArgs(rest) {
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => { const next = rest[++i]; if (!next) throw new Error(arg + ' needs a value.'); return next; };
    if (arg === '--api-key') options.apiKey = value();
    else if (arg === '--api-key-stdin') options.apiKeyStdin = true;
    else if (arg === '--protocol') options.protocol = value();
    else if (arg === '--base-url') options.baseURL = value();
    else if (arg === '--model') options.model = value();
    else if (arg === '--console') options.console = true;
    else if (arg === '--text') options.text = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--email' || arg === '--sso') { if (arg === '--email') value(); options.ignored = (options.ignored || []).concat(arg); }
    else throw new Error('Unknown option for oasis auth: ' + arg);
  }
  return options;
}

// `oasis agents --json [--all] [--cwd PATH]`: background sessions as JSON for scripts.
export async function agentsJson({ all = false, cwd = null } = {}, env = process.env) {
  const { listBackgroundSessions } = await import('./background-sessions.mjs');
  const entries = await listBackgroundSessions(env);
  const root = cwd ? path.resolve(cwd) : null;
  return entries
    .filter((entry) => all || entry.status === 'running')
    .filter((entry) => !root || path.resolve(entry.root || '') === root || path.resolve(entry.root || '').startsWith(root + path.sep))
    .map((entry) => ({ id: entry.id, name: entry.name || null, status: entry.status, kind: entry.kind || 'session', cwd: entry.root, prompt: entry.prompt || entry.command || '', model: entry.model || null, permissionMode: entry.permissionMode || null, sessionId: entry.sessionId || null, pid: entry.pid || null, startedAt: entry.startedAt, finishedAt: entry.finishedAt || null, exitCode: entry.exitCode ?? null }));
}
