// Connector cards: "connect GitHub" in plain words becomes one card with one
// Connect button. A connector is a hosted (remote) MCP server plus the sign-in
// it needs. OASIS checks whether it is already connected, and if not, the
// card writes the server to the user mcp.json, runs the sign-in and attaches
// the server's tools to the running chat, so the agent can use them in the
// same turn.
//
// Sign-in reuses what already exists instead of new auth code:
//   oauth   the MCP SDK's OAuth flow (discovery, dynamic client registration,
//           PKCE) in mcp-oauth.mjs, with the loopback callback.
//   github  GitHub's hosted MCP server has no dynamic client registration, so
//           the GitHub CLI does the sign-in: an existing `gh` login connects at
//           once, otherwise `gh auth login --web` runs GitHub's device flow and
//           the card shows the one-time code. Without gh: GitHub's device flow
//           with OASIS_GITHUB_CLIENT_ID, or a pasted token.
//   none    public servers that need no sign-in.
// Anything not in the catalog is looked up in the official MCP Registry
// (remote endpoints only), and a pasted https MCP URL works too.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadProjectMcpServers, loadUserMcpJson, loadClaudeCodeMcpServers, normalizeServerName } from './mcp-project.mjs';
import { getStoredToken, saveStoredToken, deleteStoredToken, loginMcpServer, canonicalResource } from './mcp-oauth.mjs';
import { addRemoteMcpServer, removeUserMcpJsonServer } from './mcp-remote-add.mjs';
import { onPathSync } from './clipboard-path.mjs';

// Verified hosted endpoints (vendor docs). Keep entries to servers that a
// generic MCP client can sign in to without a pre-registered client.
export const CONNECTOR_CATALOG = Object.freeze([
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'github', aliases: ['gh', 'github.com'], description: 'Repositories, issues, pull requests, Actions and code search.', docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', aliases: [], description: 'Issues, projects, cycles and documents.', docs: 'https://linear.app/docs/mcp' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', aliases: [], description: 'Pages, databases and search across your workspace.', docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', aliases: [], description: 'Errors, issues, traces and releases.', docs: 'https://mcp.sentry.dev/' },
  { id: 'atlassian', name: 'Atlassian (Jira and Confluence)', url: 'https://mcp.atlassian.com/v2/mcp', auth: 'oauth', aliases: ['jira', 'confluence', 'bitbucket'], description: 'Jira issues and Confluence pages.', docs: 'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', auth: 'oauth', aliases: [], description: 'Customers, payments, products and the Stripe docs.', docs: 'https://docs.stripe.com/mcp' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', auth: 'oauth', aliases: [], description: 'Projects, deployments and logs.', docs: 'https://vercel.com/docs/agent-resources/vercel-mcp' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', auth: 'oauth', aliases: [], description: 'Projects, databases, SQL and edge functions.', docs: 'https://supabase.com/docs/guides/ai-tools/mcp' },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', auth: 'oauth', aliases: [], description: 'Postgres projects, branches and queries.', docs: 'https://neon.com/docs/ai/neon-mcp-server' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', auth: 'oauth', aliases: [], description: 'The Cloudflare API: Workers, DNS, R2 and more.', docs: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/' },
  { id: 'cloudflare-docs', name: 'Cloudflare docs', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none', aliases: [], description: 'Search the Cloudflare developer documentation.', docs: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', auth: 'oauth', aliases: ['hf', 'hugging face'], description: 'Models, datasets, Spaces and papers on the Hub.', docs: 'https://huggingface.co/docs/hub/en/agents-mcp' },
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', auth: 'oauth', aliases: ['monday.com'], description: 'Boards, items and updates.', docs: 'https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp' },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', auth: 'oauth', aliases: [], description: 'Conversations, contacts and help-center content (US workspaces).', docs: 'https://developers.intercom.com/docs/guides/mcp' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', auth: 'oauth', aliases: [], description: 'Bases, tables and records.', docs: 'https://airtable.com/developers/agents/mcp/getting-started' },
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp', auth: 'oauth', aliases: [], description: 'Payments, orders, catalog and customers.', docs: 'https://developer.squareup.com/docs/mcp' },
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', auth: 'oauth', aliases: [], description: 'Sites, pages, CMS collections and components.', docs: 'https://developers.webflow.com/mcp/reference/getting-started' },
  { id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp', auth: 'oauth', aliases: [], description: 'Meeting notes and transcripts.', docs: 'https://docs.granola.ai/help-center/sharing/integrations/mcp' },
  { id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', aliases: ['deep wiki'], description: 'Ask questions about any public GitHub repository.', docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp' },
  { id: 'exa', name: 'Exa', url: 'https://mcp.exa.ai/mcp', auth: 'none', aliases: ['exa search'], description: 'Web and code search.', docs: 'https://exa.ai/docs/get-started/exa-mcp' },
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', auth: 'oauth', aliases: [], description: 'Invoices, orders, disputes and transactions.', docs: 'https://developer.paypal.com/ai-tools/mcp-server' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', auth: 'oauth', aliases: [], description: 'Product analytics, feature flags, experiments and errors.', docs: 'https://posthog.com/docs/model-context-protocol' },
  { id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp', auth: 'oauth', aliases: [], description: 'Sites, deploys, environment variables and forms.', docs: 'https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/' },
  { id: 'prisma', name: 'Prisma', url: 'https://mcp.prisma.io/mcp', auth: 'oauth', aliases: [], description: 'Prisma Postgres databases, backups and schema changes.', docs: 'https://www.prisma.io/docs/ai/tools/mcp-server' },
  { id: 'semgrep', name: 'Semgrep', url: 'https://mcp.semgrep.ai/mcp', auth: 'oauth', aliases: [], description: 'Security scans and findings for your code.', docs: 'https://docs.semgrep.dev/mcp/overview' },
  { id: 'jam', name: 'Jam', url: 'https://mcp.jam.dev/mcp', auth: 'oauth', aliases: [], description: 'Bug reports with console logs, network requests and replays.', docs: 'https://jam.dev/docs/jam-mcp' },
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', auth: 'oauth', aliases: [], description: 'Wix sites, stores, bookings and content.', docs: 'https://www.wix.com/studio/developers/mcp-server' },
  { id: 'supermemory', name: 'Supermemory', url: 'https://mcp.supermemory.ai/mcp', auth: 'oauth', aliases: [], description: 'Long-term memory shared across your AI tools.', docs: 'https://supermemory.ai/docs/supermemory-mcp/mcp' },
  { id: 'apify', name: 'Apify', url: 'https://mcp.apify.com', auth: 'oauth', aliases: [], description: 'Thousands of ready-made web data tools (Actors).', docs: 'https://docs.apify.com/platform/integrations/mcp' },
  { id: 'tavily', name: 'Tavily', url: 'https://mcp.tavily.com/mcp', auth: 'oauth', aliases: [], description: 'Web search and page extraction built for agents.', docs: 'https://docs.tavily.com/documentation/mcp' },
  { id: 'close', name: 'Close', url: 'https://mcp.close.com/mcp', auth: 'oauth', aliases: [], description: 'CRM leads, contacts, opportunities and activities.', docs: 'https://developer.close.com/mcp/' },
  { id: 'attio', name: 'Attio', url: 'https://mcp.attio.com/mcp', auth: 'oauth', aliases: [], description: 'CRM records, lists, notes and tasks.', docs: 'https://docs.attio.com/mcp/overview' },
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp', auth: 'oauth', aliases: [], description: 'Tasks, projects and due dates.', docs: 'https://www.todoist.com/help/todoist/todoist-and-ai/connect-todoist-to-an-ai-assistant-xMSzFfHng' },
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', auth: 'none', aliases: [], description: 'Up-to-date library and framework docs for coding.', docs: 'https://context7.com/docs/installation' }
]);

export const CONNECT_SERVICE_TOOL_DEFINITION = { type: 'function', function: {
  name: 'connect_service',
  description: 'Connect an app or account (GitHub, Linear, Notion, Sentry, Jira, Stripe, Vercel, Supabase, ...) when the user asks to connect, link or sign in to it, or when the task needs its data. Checks whether it is already connected first; if not, shows the user a connector card with a Connect button and waits. Once connected, the service\'s tools are available in this chat. Pass a service name, an MCP Registry name or an https MCP server URL.',
  parameters: { type: 'object', properties: {
    service: { type: 'string', minLength: 1, maxLength: 300, description: 'What to connect, e.g. "github", "linear", "jira" or https://example.com/mcp' },
    reason: { type: 'string', maxLength: 200, description: 'One short line shown on the card: what you will use it for' }
  }, required: ['service'], additionalProperties: false }
} };

const slug = (value) => String(value || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9.]+/g, ' ').trim();

/** Catalog entry for a name or alias, or null. */
export function findCatalogConnector(query) {
  const wanted = slug(query).replace(/\b(mcp|server|app|account|connector|integration|the|my|connect|to|with|link|sign|in|into|please|me|up)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!wanted) return null;
  const compact = wanted.replace(/[\s.]/g, '');
  for (const item of CONNECTOR_CATALOG) {
    const names = [item.id, item.name, ...item.aliases].map((name) => slug(name).replace(/[\s.]/g, ''));
    if (names.includes(compact)) return item;
  }
  // A single known name inside a short phrase ("github account for this repo").
  const words = wanted.split(' ');
  if (words.length <= 6) {
    for (const item of CONNECTOR_CATALOG) {
      const names = [item.id, item.name, ...item.aliases].map((name) => slug(name).replace(/[\s.]/g, ''));
      if (words.some((word) => names.includes(word.replace(/[.]/g, '')))) return item;
    }
  }
  // Pasted URL of a catalog server.
  for (const item of CONNECTOR_CATALOG) {
    try { if (/^https?:/i.test(String(query).trim()) && canonicalResource(String(query).trim()) === canonicalResource(item.url)) return item; } catch {}
  }
  return null;
}

/**
 * Resolves what the user asked for into a connector:
 * { id, name, url, auth, description, docs, source: 'catalog'|'registry'|'url' }.
 */
export async function resolveConnector(query, { env = process.env, fetchImpl, signal } = {}) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Name the service to connect, for example github or linear.');
  const known = findCatalogConnector(text);
  if (known) return { ...known, source: 'catalog' };
  if (/^https:\/\//i.test(text) || /^http:\/\/(localhost|127\.)/i.test(text)) {
    const url = new URL(text);
    const id = normalizeServerName(url.hostname.replace(/^(www|mcp|api)\./, '').split('.')[0] || 'remote');
    return { id, name: url.hostname, url: url.toString(), auth: 'oauth', aliases: [], description: 'Remote MCP server at ' + url.hostname + '.', docs: '', source: 'url' };
  }
  // Not in the catalog: the official MCP Registry, remote endpoints only.
  const registry = await import('./mcp-registry.mjs');
  const rows = await registry.searchRegistry(text, { env, fetchImpl, signal, limit: 10 }).catch(() => []);
  for (const row of rows.filter((item) => item.kinds.includes('remote') || item.kinds.includes('sse'))) {
    const server = await registry.getRegistryServer(row.name, { env, fetchImpl, signal }).catch(() => null);
    if (!server) continue;
    let built;
    try { built = registry.entryFromRegistry(server, { prefer: 'remote', env }); } catch { continue; }
    // A remote that needs a pasted secret header is not a one-click connector.
    if (built.requiredEnv.length) continue;
    return { id: registry.defaultLocalName(server.name), name: row.title || registry.defaultLocalName(server.name), url: built.entry.url, transport: built.entry.type, auth: 'oauth', aliases: [], description: row.description || '', docs: row.repository || '', registryName: server.name, source: 'registry' };
  }
  throw new Error('No connector found for "' + text.slice(0, 80) + '". Known connectors: ' + CONNECTOR_CATALOG.map((item) => item.id).join(', ') + '. You can also paste the service\'s https MCP server URL.');
}

// Every place OASIS reads HTTP MCP servers from, the same order mcp login uses.
async function configuredHttpServers(root, env) {
  const project = await loadProjectMcpServers(root, { env }).catch(() => ({ servers: [] }));
  const user = await loadUserMcpJson({ env }).catch(() => ({ servers: [] }));
  const claude = await loadClaudeCodeMcpServers(root, { env }).catch(() => ({ local: [], user: [] }));
  return [...(project.servers || []), ...(user.servers || []), ...(claude.local || []), ...(claude.user || [])].filter((item) => item.type === 'http' || item.type === 'sse');
}

const sameUrl = (a, b) => { try { return canonicalResource(a) === canonicalResource(b); } catch { return false; } };
const hasAuthHeader = (server) => Object.keys(server.headers || {}).some((key) => /^authorization$/i.test(key));

/**
 * Whether a connector is set up here:
 * { configured: server|null, signedIn, live: client|null, tools: [names] }.
 * live means this chat already has its tools.
 */
export async function connectorStatus(connector, { root = process.cwd(), env = process.env, session = null } = {}) {
  const servers = await configuredHttpServers(root, env);
  const configured = servers.find((item) => sameUrl(item.url, connector.url)) || servers.find((item) => item.name === connector.id) || null;
  let signedIn = connector.auth === 'none' || Boolean(configured && hasAuthHeader(configured));
  if (!signedIn) {
    try { const entry = await getStoredToken((configured || connector).url, env); signedIn = Boolean(entry && (entry.accessToken || (entry.tokens && entry.tokens.access_token))); } catch {}
  }
  let live = null;
  if (session && session.mcpClients instanceof Map) {
    for (const [name, client] of session.mcpClients) {
      const url = client && client.config && client.config.url;
      if ((url && sameUrl(url, connector.url)) || (configured && name === configured.name)) { live = client; break; }
    }
  }
  const tools = live && Array.isArray(live.tools) ? live.tools.map((tool) => tool.name).filter(Boolean) : [];
  return { configured, signedIn, live: live && tools.length ? live : null, tools };
}

/* ---------- GitHub sign-in through the GitHub CLI ---------- */

const GH_SCOPES = 'repo,read:org,workflow,gist';

function runGh(args, { env, timeoutMs = 15000, spawnImpl = spawn, onStderr } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try { child = spawnImpl('gh', args, { env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { resolve({ code: -1, out: '', err: String(error.message || error) }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; if (onStderr) onStderr(err); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(error.message || error), child }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, child }); });
    if (onStderr) onStderr('', child);
  });
}

/** One-time code and URL from `gh auth login --web` output, or null. */
export function parseGhDevicePrompt(text) {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(String(text || ''));
  const url = /(https:\/\/github\.com\/login\/device\S*)/i.exec(String(text || ''));
  return code ? { code: code[1].toUpperCase(), url: url ? url[1] : 'https://github.com/login/device' } : null;
}

async function checkGitHubToken(token, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('https://api.github.com/user', { headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'oasis-cli' } });
  if (response.status === 401) throw new Error('GitHub did not accept that token.');
  if (!response.ok) throw new Error('GitHub answered HTTP ' + response.status + ' when checking the token.');
  const body = await response.json().catch(() => ({}));
  return { login: String(body.login || ''), scopes: String(response.headers.get('x-oauth-scopes') || '') };
}

// GitHub's own device flow, for computers without gh. Needs an OAuth app's
// client ID (device flow enabled): OASIS_GITHUB_CLIENT_ID.
async function githubDeviceFlow(clientId, { fetchImpl = globalThis.fetch, onCode, signal, timeoutMs = 15 * 60 * 1000 } = {}) {
  const form = (body) => ({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const start = await (await fetchImpl('https://github.com/login/device/code', form({ client_id: clientId, scope: GH_SCOPES.replace(/,/g, ' ') }))).json();
  if (!start.device_code) throw new Error('GitHub did not start the device sign-in: ' + (start.error_description || start.error || 'no device code'));
  onCode({ code: start.user_code, url: start.verification_uri || 'https://github.com/login/device' });
  let interval = Math.max(5, Number(start.interval) || 5) * 1000;
  const deadline = Date.now() + Math.min(timeoutMs, (Number(start.expires_in) || 900) * 1000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (signal && signal.aborted) throw new Error('Sign-in was cancelled.');
    const poll = await (await fetchImpl('https://github.com/login/oauth/access_token', form({ client_id: clientId, device_code: start.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }))).json();
    if (poll.access_token) return poll.access_token;
    if (poll.error === 'slow_down') interval += 5000;
    else if (poll.error && poll.error !== 'authorization_pending') throw new Error('GitHub sign-in failed: ' + (poll.error_description || poll.error));
  }
  throw new Error('Timed out waiting for GitHub sign-in.');
}

/* ---------- The connect flow behind one card ---------- */

/**
 * One connector card. The UI shows `view()`, calls connect() when the user
 * clicks Connect, and reads view() again (or listens to onUpdate) for the
 * sign-in link, the GitHub one-time code, a token box, and the result.
 *
 * states: ready → working → authorize | device | token → connected | failed | skipped
 */
export function createConnectFlow(connector, { root = process.cwd(), env = process.env, session = null, reason = '', onUpdate = () => {}, deps = {} } = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const login = deps.loginMcpServer || loginMcpServer;
  const addServer = deps.addRemoteMcpServer || addRemoteMcpServer;
  const reconnect = deps.reconnectMcpServer || (async (target, config, options) => (await import('./mcp.mjs')).reconnectMcpServer(target, config, options));
  const ghAvailable = deps.ghAvailable ?? onPathSync('gh', env);
  const spawnImpl = deps.spawn || spawn;
  const id = randomUUID();
  const state = { id, status: 'ready', connector: { id: connector.id, name: connector.name, description: connector.description || '', url: connector.url, auth: connector.auth, docs: connector.docs || '', source: connector.source || 'catalog' }, reason: String(reason || '').slice(0, 200), url: '', code: '', message: '', account: '', tools: [], serverName: '', canPasteCallback: false };
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  let deliverCallback = null;
  let tokenWaiter = null;
  let ghChild = null;
  let started = false;
  const listeners = new Set([onUpdate]);
  const update = (patch) => { Object.assign(state, patch); const snapshot = view(); for (const listener of listeners) { try { listener(snapshot); } catch {} } };
  const view = () => ({ ...state, connector: { ...state.connector }, tools: state.tools.slice(0, 50) });
  const finish = (status, patch = {}) => {
    if (['connected', 'failed', 'skipped'].includes(state.status)) return;
    update({ status, url: '', code: '', canPasteCallback: false, ...patch });
    if (ghChild) { try { ghChild.kill(); } catch {} ghChild = null; }
    settle(view());
  };

  async function ensureConfigured() {
    const status = await connectorStatus(connector, { root, env, session });
    if (status.configured) return status.configured;
    const name = normalizeServerName(connector.id);
    await addServer(['--transport', connector.transport === 'sse' ? 'sse' : 'http', name, connector.url], { root, env, approve: async () => true });
    const servers = await configuredHttpServers(root, env);
    const added = servers.find((item) => sameUrl(item.url, connector.url));
    if (!added) throw new Error('Saved ' + name + ' to mcp.json but could not read it back.');
    return added;
  }

  async function signInGitHub(server) {
    let token = '';
    let how = '';
    // 1. Already signed in to the GitHub CLI: connects at once.
    if (ghAvailable) {
      const existing = await runGh(['auth', 'token', '--hostname', 'github.com'], { env, spawnImpl });
      if (existing.code === 0 && existing.out.trim()) { token = existing.out.trim(); how = 'your GitHub CLI sign-in'; }
    }
    // 2. gh installed but signed out: gh runs GitHub's device flow; show its code.
    if (!token && ghAvailable) {
      const result = await runGh(['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key', '--scopes', GH_SCOPES], {
        env, spawnImpl, timeoutMs: 15 * 60 * 1000,
        onStderr: (text, child) => {
          if (child) ghChild = child;
          const prompt = parseGhDevicePrompt(text);
          if (prompt && state.code !== prompt.code) update({ status: 'device', code: prompt.code, url: prompt.url, message: 'Enter this code on GitHub to finish.' });
        }
      });
      ghChild = null;
      if (state.status === 'skipped') return;
      if (result.code === 0) {
        const after = await runGh(['auth', 'token', '--hostname', 'github.com'], { env, spawnImpl });
        if (after.code === 0 && after.out.trim()) { token = after.out.trim(); how = 'GitHub (also signed in the GitHub CLI)'; }
      }
    }
    // 3. No gh: GitHub's device flow with a configured OAuth app.
    if (!token && env.OASIS_GITHUB_CLIENT_ID) {
      token = await githubDeviceFlow(String(env.OASIS_GITHUB_CLIENT_ID), { fetchImpl, onCode: ({ code, url }) => update({ status: 'device', code, url, message: 'Enter this code on GitHub to finish.' }) });
      how = 'GitHub';
    }
    // 4. Last resort: a pasted token.
    if (!token) {
      update({ status: 'token', url: 'https://github.com/settings/tokens/new?description=OASIS&scopes=' + encodeURIComponent(GH_SCOPES), message: ghAvailable ? 'GitHub sign-in did not finish. Paste a GitHub token instead.' : 'Install the GitHub CLI (gh) for one-click sign-in, or paste a GitHub token.' });
      token = await new Promise((resolve) => { tokenWaiter = resolve; });
      tokenWaiter = null;
      if (!token) return;
      how = 'a pasted token';
    }
    const who = await checkGitHubToken(token, fetchImpl);
    await saveStoredToken(server.url, { server: server.name, resource: canonicalResource(server.url), accessToken: token, tokenType: 'Bearer', scope: who.scopes || null, expiresAt: null, obtainedAt: new Date().toISOString(), source: 'github-connector' }, env);
    update({ account: who.login ? '@' + who.login : '', message: 'Signed in with ' + how + '.' });
  }

  async function signInOAuth(server) {
    const result = await login(server, {
      env, ...(deps.fetch ? { fetch: deps.fetch } : {}),
      print: () => {},
      // The page opens the link (it has the user's click); the terminal opens it itself.
      open: (url) => { update({ status: 'authorize', url, message: 'Approve access in the page that opened, then come back here.', canPasteCallback: Boolean(deliverCallback) }); if (deps.openBrowser) deps.openBrowser(url); },
      onCallbackReady: (deliver) => { deliverCallback = deliver; }
    });
    deliverCallback = null;
    update({ message: result.alreadyAuthorized ? 'Already signed in.' : 'Signed in.' });
  }

  async function run() {
    try {
      update({ status: 'working', message: 'Setting up ' + connector.name + '...' });
      const server = await ensureConfigured();
      update({ serverName: server.name });
      const status = await connectorStatus(connector, { root, env, session });
      if (!status.signedIn) {
        if (connector.auth === 'github') await signInGitHub(server);
        else if (connector.auth !== 'none') await signInOAuth(server);
      }
      if (state.status === 'skipped') return;
      let tools = [];
      if (session) {
        const client = await reconnect(session, server, { env, host: session.mcpHost });
        tools = (client && client.tools || []).map((tool) => tool.name).filter(Boolean);
      }
      finish('connected', { tools, message: connector.name + ' is connected' + (state.account ? ' as ' + state.account : '') + (session ? '. ' + tools.length + ' tool(s) are ready in this chat.' : '. Its tools are ready from your next message.') });
    } catch (error) {
      finish('failed', { message: String(error && error.message || error).slice(0, 600) });
    }
  }

  return {
    id,
    done,
    view,
    /** Calls fn(view) on every change; returns an unsubscribe function. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The user clicked Connect. */
    connect() { if (started) return view(); started = true; void run(); return view(); },
    /** The user clicked Not now. */
    skip() { if (tokenWaiter) tokenWaiter(''); finish('skipped', { message: 'Not connected.' }); return view(); },
    /** Token pasted into the card (GitHub without gh). */
    submitToken(token) {
      const value = String(token || '').trim();
      if (!tokenWaiter) throw new Error('This card is not waiting for a token.');
      if (!/^[A-Za-z0-9_]{20,255}$/.test(value)) throw new Error('That does not look like a GitHub token.');
      tokenWaiter(value);
      return view();
    },
    /** Redirect address pasted from another device's browser. */
    pasteCallback(address) {
      if (!deliverCallback) throw new Error('This card is not waiting for a sign-in address.');
      const outcome = deliverCallback(address);
      if (outcome === 'invalid') throw new Error('Paste the full address from the browser, starting with http://127.0.0.1.');
      if (outcome === 'stale') throw new Error('That address is from an older sign-in. Use the latest link on this card.');
      return view();
    }
  };
}

/**
 * The connect_service tool. options.connectorCard(flow) shows the card and
 * resolves when the flow settles; without it (non-interactive runs) the tool
 * explains how to connect instead.
 */
export async function runConnectService(session, args, options = {}) {
  const env = options.env || process.env;
  const root = session && session.root || options.root || process.cwd();
  let connector;
  try { connector = await resolveConnector(args.service, { env, signal: options.signal }); }
  catch (error) { return { connected: false, message: error.message }; }
  const status = await connectorStatus(connector, { root, env, session });
  // reauth: the server just refused this chat's sign-in, so a live client does not count.
  if (status.live && !options.reauth) {
    return { connected: true, alreadyConnected: true, service: connector.name, server: status.live.config && status.live.config.name || connector.id, tools: status.tools.slice(0, 60), message: connector.name + ' is already connected in this chat. Use its tools (' + status.tools.length + ').' };
  }
  // Set up and signed in earlier, just not running in this chat: attach it quietly.
  if (status.configured && status.signedIn && session && !options.reauth) {
    try {
      const { reconnectMcpServer } = await import('./mcp.mjs');
      const client = await reconnectMcpServer(session, status.configured, { env, host: session.mcpHost });
      const tools = (client.tools || []).map((tool) => tool.name).filter(Boolean);
      if (tools.length) return { connected: true, alreadyConnected: true, service: connector.name, server: status.configured.name, tools: tools.slice(0, 60), message: connector.name + ' was already set up; it is connected now with ' + tools.length + ' tool(s).' };
    } catch {}
  }
  if (typeof options.connectorCard !== 'function') {
    return { connected: false, service: connector.name, message: 'No one is here to click Connect (non-interactive run). Tell the user to run: oasis mcp connect ' + connector.id + ' (or ask again in the terminal or web app).' };
  }
  const flow = createConnectFlow(connector, { root, env, session, reason: args.reason });
  const result = await options.connectorCard(flow);
  const final = result && result.status ? result : flow.view();
  if (final.status === 'connected') return { connected: true, service: connector.name, server: final.serverName, ...(final.account ? { account: final.account } : {}), tools: final.tools.slice(0, 60), message: final.message };
  if (final.status === 'skipped') return { connected: false, skipped: true, service: connector.name, message: 'The user chose not to connect ' + connector.name + ' now. Continue without it, or say what it would add.' };
  return { connected: false, service: connector.name, message: 'Connecting ' + connector.name + ' failed: ' + (final.message || 'unknown error') };
}

/** Connectors with their status, for Settings and `oasis mcp connect` with no name. */
export async function listConnectors({ root = process.cwd(), env = process.env, session = null } = {}) {
  return await Promise.all(CONNECTOR_CATALOG.map(async (item) => {
    const status = await connectorStatus(item, { root, env, session }).catch(() => ({ configured: null, signedIn: false, live: null, tools: [] }));
    return { id: item.id, name: item.name, aliases: item.aliases, description: item.description, auth: item.auth, configured: Boolean(status.configured), signedIn: status.signedIn, connected: Boolean(status.configured) && status.signedIn, live: Boolean(status.live), tools: status.tools.length };
  }));
}

/**
 * Disconnect: forgets the sign-in and removes the server OASIS added to
 * mcp.json. Servers from a project .mcp.json or a plugin stay configured.
 */
export async function disconnectConnector(query, { root = process.cwd(), env = process.env } = {}) {
  const connector = await resolveConnector(query, { env });
  const status = await connectorStatus(connector, { root, env });
  const urls = new Set([connector.url, status.configured && status.configured.url].filter(Boolean));
  let signedOut = false;
  for (const url of urls) { try { if (await deleteStoredToken(url, env)) signedOut = true; } catch {} }
  let removed = null;
  if (status.configured) removed = await removeUserMcpJsonServer(status.configured.name, { env }).catch(() => null);
  const parts = [];
  if (signedOut) parts.push('signed out');
  if (removed) parts.push('removed from mcp.json');
  const note = connector.id === 'github' && signedOut ? ' Your GitHub CLI (gh) sign-in is unchanged.' : '';
  return { service: connector.name, signedOut, removed: Boolean(removed), message: parts.length ? connector.name + ': ' + parts.join(' and ') + '.' + note : connector.name + ' was not connected.' };
}

/* ---------- The card in a terminal ---------- */

/** Draws the card as a box of text lines (no colour codes; width-safe). */
export function terminalCardLines(view, width = 72) {
  const inner = Math.max(40, Math.min(width, 90)) - 4;
  const wrap = (text) => {
    const out = [];
    let line = '';
    for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + word).trim().length > inner) { if (line) out.push(line); line = word.slice(0, inner); }
      else line = (line + ' ' + word).trim();
    }
    if (line) out.push(line);
    return out;
  };
  const rows = [
    ...wrap('Connect ' + view.connector.name),
    ...wrap(view.connector.description),
    ...(view.reason ? wrap('For: ' + view.reason) : []),
    ...wrap(view.connector.auth === 'github' ? 'Signs in with the GitHub CLI (or a token). The token stays in your OASIS config folder.' : view.connector.auth === 'none' ? 'No sign-in needed.' : 'Opens ' + view.connector.name + ' in your browser to approve access. The token stays in your OASIS config folder.')
  ];
  return ['┌' + '─'.repeat(inner + 2) + '┐', ...rows.map((row) => '│ ' + row.padEnd(inner) + ' │'), '└' + '─'.repeat(inner + 2) + '┘'];
}

/**
 * Shows a connector card in a terminal and runs it. io: { write(text),
 * askLine(prompt) → string, askSecret?(prompt) → string, open?(url), width }.
 */
export async function connectInTerminal(flow, io) {
  const write = io.write;
  write('\n' + terminalCardLines(flow.view(), io.width || 72).join('\n') + '\n');
  let answer = '';
  try { answer = String(await io.askLine('Connect ' + flow.view().connector.name + '? [Y/n] ') || '').trim(); } catch { answer = 'n'; }
  if (/^n/i.test(answer)) { flow.skip(); write('Not connected.\n'); return flow.done; }
  let shown = '';
  const unsubscribe = flow.subscribe(async (view) => {
    const key = view.status + ':' + view.url + ':' + view.code;
    if (key === shown) return;
    shown = key;
    if (view.status === 'authorize' && view.url) {
      write('Approve access in your browser:\n  ' + view.url + '\nWaiting for the browser to finish...\n');
      if (io.open) io.open(view.url);
    } else if (view.status === 'device' && view.code) {
      write('On GitHub, enter the one-time code  ' + view.code + '\n  ' + view.url + '\nWaiting for GitHub...\n');
      if (io.open) io.open(view.url);
    } else if (view.status === 'token') {
      write(view.message + '\nCreate one here (scopes are pre-filled): ' + view.url + '\n');
      let token = '';
      try { token = String(await (io.askSecret || io.askLine)('GitHub token (Enter to skip): ') || '').trim(); } catch {}
      if (!token) { flow.skip(); return; }
      try { flow.submitToken(token); } catch (error) { write(error.message + '\n'); flow.skip(); }
    }
  });
  flow.connect();
  const final = await flow.done;
  unsubscribe();
  write((final.status === 'connected' ? '✓ ' : final.status === 'skipped' ? '' : '✗ ') + final.message + '\n');
  return final;
}

/** `oasis mcp connect [NAME]`: lists connectors, or connects one. */
export async function connectCommand(name, { root = process.cwd(), env = process.env, write, askLine, askSecret, open, session = null, width } = {}) {
  if (!name) {
    const rows = await listConnectors({ root, env, session });
    write('Connectors (oasis mcp connect NAME, or just ask: "connect linear"):\n');
    for (const row of rows) write('  ' + row.id.padEnd(16) + (row.signedIn && row.configured ? 'connected   ' : row.configured ? 'needs sign-in' : 'not set up  ') + '  ' + row.description + '\n');
    write('Anything else: oasis mcp connect <MCP Registry name or https MCP URL>.\n');
    return null;
  }
  const connector = await resolveConnector(name, { env });
  const status = await connectorStatus(connector, { root, env, session });
  if (status.configured && status.signedIn) { write(connector.name + ' is already connected (' + status.configured.name + '). It loads in every new chat.\n'); return null; }
  const flow = createConnectFlow(connector, { root, env, session });
  return await connectInTerminal(flow, { write, askLine, askSecret, open, width });
}
