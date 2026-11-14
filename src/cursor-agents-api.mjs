// Cursor Cloud Agents API–compatible REST surface for `oasis web`.
//
// Scripts and tools written for Cursor's Cloud Agents API (v1, and the legacy
// v0 with statusChange webhooks) can drive OASIS agents on this computer with
// whatever model OASIS is configured to use. The mapping:
//
//   Cursor agent  -> an OASIS conversation (saved session) in the served folder
//   Cursor run    -> one OASIS agent turn (a web job)
//   API key       -> the web server's access key (Bearer, or Basic with the key
//                    as the username and an empty password), checked by web.mjs
//                    before any request reaches this module
//
// What does not map is refused with a clear 4xx instead of being ignored:
// OASIS does not create branches or pull requests, run in Cursor's cloud,
// accept inline MCP servers / subagents / env vars, or fetch images by URL.
// The repository must be the folder this server serves. Approvals still apply:
// a run that needs one waits (status RUNNING, oasis.waitingForApproval true)
// until someone approves it in the OASIS app or through /api/jobs/ID/approval.
//
// Field names and shapes follow Cursor's public API reference
// (cursor.com/docs/cloud-agent/api); this is an independent implementation.
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getConfigDirectory } from './config.mjs';
import { atomicWriteFile } from './atomic-write.mjs';
import { isLoopbackAddress } from './remote-access.mjs';
import { sniffImageType } from './images.mjs';

const AGENT_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;
const ACTIVE_JOB = new Set(['running', 'waiting_approval', 'queued', 'starting']);
const MAX_PROMPT = 12000;
const MAX_IMAGES = 4;
// The run's final reply; 24,000 cut long answers short.
const MAX_RESULT_CHARS = 1_000_000;
const MAX_AGENTS = 1000;
const MAX_RUNS_PER_AGENT = 500;
const HEARTBEAT_MS = 15000;
const STREAM_RETENTION_SECONDS = 7 * 24 * 3600;
const WEBHOOK_USER_AGENT = 'Cursor-Agent-Webhook/1.0';

class CursorApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new CursorApiError(status, code, message); };

export function cursorError(res, status, code, message) {
  const body = Buffer.from(JSON.stringify({ error: { code, message } }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

/** `Authorization: Basic base64(KEY:)`, as Cursor's API accepts. The password must be empty. */
export function basicAuthToken(header) {
  const match = String(header || '').match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 1) return null;
  if (decoded.slice(colon + 1) !== '') return null;
  return decoded.slice(0, colon);
}

/** Normalises a repository reference for comparison: GitHub-style URLs, SSH remotes, file URLs. */
export function normalizeRepoUrl(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (/^file:\/\//i.test(text)) {
    try { return 'file:' + path.resolve(fileURLToPath(text)); } catch { return ''; }
  }
  if (path.isAbsolute(text)) return 'file:' + path.resolve(text);
  const ssh = text.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i);
  if (ssh) text = 'https://' + ssh[1] + '/' + ssh[2];
  if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
  try {
    const url = new URL(text);
    const pathname = url.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
    return 'https://' + url.host.toLowerCase() + pathname.toLowerCase();
  } catch { return ''; }
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 10000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve(error ? '' : String(stdout || '').trim()));
  });
}

async function folderInfo(folder) {
  const [remote, branch, head] = await Promise.all([git(folder, ['config', '--get', 'remote.origin.url']), git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']), git(folder, ['rev-parse', 'HEAD'])]);
  const remoteUrl = remote && !/^file:|^\//.test(remote) ? 'https://' + normalizeRepoUrl(remote).slice('https://'.length) : '';
  // Never echo credentials embedded in a remote URL.
  const safeRemote = remoteUrl.replace(/\/\/[^/@]+@/, '//');
  const fileUrl = pathToFileURL(folder).href;
  const match = safeRemote.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
  return { folder, remoteUrl: safeRemote, fileUrl, url: safeRemote || fileUrl, branch: branch && branch !== 'HEAD' ? branch : '', head, owner: match ? match[1] : 'local', name: match ? match[2] : path.basename(folder) };
}

function realFolder(folder) {
  try { return realpathSync(folder); } catch { return path.resolve(folder); }
}

function toolResultValue(text) {
  if (typeof text !== 'string') return text == null ? null : text;
  try { return JSON.parse(text); } catch { return text; }
}

function zeroUsage() { return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 }; }
function addUsage(target, usage) {
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  target.inputTokens += n(usage.inputTokens);
  target.outputTokens += n(usage.outputTokens);
  target.cacheWriteTokens += n(usage.cacheCreationTokens ?? usage.cacheWriteTokens);
  target.cacheReadTokens += n(usage.cacheReadTokens);
  target.totalTokens = target.inputTokens + target.outputTokens + target.cacheWriteTokens + target.cacheReadTokens;
  return target;
}

function validateWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { fail(400, 'validation_error', 'webhook.url must be an absolute URL.'); }
  if (String(value).length > 2048) fail(400, 'validation_error', 'webhook.url is too long (2,048 characters maximum).');
  if (url.username || url.password) fail(400, 'validation_error', 'webhook.url must not contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || isLoopbackAddress(host);
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && loopback) return url.href;
  fail(400, 'validation_error', 'webhook.url must use HTTPS (plain HTTP is allowed only for localhost).');
}

/** Signs a webhook body the way Cursor documents: sha256=<hex HMAC-SHA256 of the raw body>. */
function webhookSignature(secret, body) {
  return 'sha256=' + createHmac('sha256', String(secret)).update(body).digest('hex');
}

export function createCursorAgentsApi(options) {
  const env = options.env || process.env;
  const serverRoot = path.resolve(options.root);
  const jobs = options.jobs;
  const taskStore = options.taskStore;
  const getActiveRoot = options.activeRoot;
  const startedAt = new Date().toISOString();
  const retryDelays = Array.isArray(options.webhookRetryDelaysMs) ? options.webhookRetryDelaysMs : [1000, 5000, 20000];
  const storeFile = path.join(getConfigDirectory(env), 'cursor-agents', createHash('sha256').update(serverRoot).digest('hex').slice(0, 24) + '.json');
  let state = null;
  let loading = null;
  let writing = Promise.resolve();
  const runByJob = new Map();
  const liveUsage = new Map();
  const pendingWebhooks = new Set();

  async function load() {
    if (state) return state;
    if (!loading) loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(storeFile, 'utf8'));
        state = parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.agents) ? parsed : { schemaVersion: 1, agents: [] };
      } catch { state = { schemaVersion: 1, agents: [] }; }
      for (const agent of state.agents) for (const run of agent.runs || []) if (run.jobId) runByJob.set(run.jobId, { agent, run });
      return state;
    })();
    return loading;
  }

  function save() {
    const snapshot = JSON.stringify(state, null, 2) + '\n';
    writing = writing.then(async () => {
      await mkdir(path.dirname(storeFile), { recursive: true, mode: 0o700 });
      try { await chmod(path.dirname(storeFile), 0o700); } catch {}
      await atomicWriteFile(storeFile, snapshot, { mode: 0o600 });
    }).catch(() => {});
    return writing;
  }

  function findAgent(id) {
    const agent = AGENT_ID.test(String(id || '')) ? state.agents.find((item) => item.id === String(id).toLowerCase()) : null;
    if (!agent) fail(404, 'agent_not_found', 'No agent with that ID on this OASIS server.');
    return agent;
  }

  function findRun(agent, runId) {
    const run = RUN_ID.test(String(runId || '')) ? agent.runs.find((item) => item.id === String(runId).toLowerCase()) : null;
    if (!run) fail(404, 'run_not_found', 'No run with that ID on this agent.');
    return run;
  }

  // ---- run status -----------------------------------------------------------

  async function jobFor(run) {
    const live = run.jobId ? jobs.get(run.jobId) : null;
    if (live) return { job: live, live: true };
    const saved = run.jobId && taskStore ? await taskStore.get(run.jobId).catch(() => null) : null;
    return { job: saved, live: false };
  }

  function statusOf(job, run) {
    if (run.final) return run.final.status;
    if (!job) return run.pending ? 'CREATING' : 'EXPIRED';
    if (ACTIVE_JOB.has(job.status)) return 'RUNNING';
    if (job.status === 'completed') return 'FINISHED';
    if (job.status === 'cancelled') return 'CANCELLED';
    return 'ERROR';
  }

  function finalize(entry, job) {
    const { agent, run } = entry;
    if (run.final || !job || ACTIVE_JOB.has(job.status)) return false;
    const status = statusOf(job, run);
    const endedAt = (job.events && job.events.at(-1) && job.events.at(-1).at) || new Date().toISOString();
    const result = job.status === 'completed' ? String(job.result && job.result.text || '').slice(0, MAX_RESULT_CHARS)
      : job.status === 'cancelled' ? 'Stopped on request.'
      : String(job.error || 'The run failed.').slice(0, 4000);
    run.final = { status, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.createdAt)) || 0, result };
    const usage = liveUsage.get(run.jobId);
    if (usage) run.usage = usage;
    liveUsage.delete(run.jobId);
    if (job.result && job.result.sessionId && /^[a-f0-9-]{20,80}$/i.test(job.result.sessionId)) agent.sessionId = job.result.sessionId;
    agent.updatedAt = endedAt;
    void save();
    if (agent.webhook) queueWebhook(agent, run);
    // A steer that arrived when no running turn could take it becomes the next follow-up.
    if (Array.isArray(agent.queued) && agent.queued.length && !agent.archived) {
      const next = agent.queued.shift();
      void save();
      startRun(agent, next).catch(() => {});
    }
    return true;
  }

  async function runView(agent, run) {
    const { job, live } = await jobFor(run);
    if (!run.final && job && !ACTIVE_JOB.has(job.status)) finalize({ agent, run }, job);
    const status = statusOf(job, run);
    const view = { id: run.id, agentId: agent.id, status, createdAt: run.createdAt, updatedAt: run.final ? run.final.endedAt : (job && job.events && job.events.at(-1) && job.events.at(-1).at) || run.createdAt };
    if (run.final) {
      view.durationMs = run.final.durationMs;
      if (run.final.result) view.result = run.final.result;
    }
    view.oasis = { jobId: run.jobId || null, sessionId: agent.sessionId || null, ...(live && job.status === 'waiting_approval' ? { waitingForApproval: true } : {}) };
    return view;
  }

  function activeRun(agent) {
    for (const run of [...agent.runs].reverse()) {
      if (run.final) continue;
      if (run.pending) return run;
      const job = run.jobId ? jobs.get(run.jobId) : null;
      if (job && ACTIVE_JOB.has(job.status)) return run;
    }
    return null;
  }

  // ---- agent views ------------------------------------------------------------

  function originOf(req) {
    const host = String(req.headers.host || '127.0.0.1').split(',')[0].trim();
    const secure = Boolean(req.socket && req.socket.encrypted) || (options.trustProxy && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '')));
    return (secure ? 'https://' : 'http://') + (options.trustProxy && req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',')[0].trim() : host);
  }

  function agentSummary(agent, req) {
    const latest = agent.runs.at(-1);
    return {
      id: agent.id,
      name: agent.name,
      status: agent.archived ? 'ARCHIVED' : 'ACTIVE',
      env: { type: 'machine', name: 'oasis' },
      url: originOf(req) + '/app/',
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      ...(latest ? { latestRunId: latest.id } : {})
    };
  }

  function agentView(agent, req) {
    return {
      ...agentSummary(agent, req),
      repos: [{ url: agent.repoUrl, ...(agent.startingRef ? { startingRef: agent.startingRef } : {}) }],
      workOnCurrentBranch: true,
      autoCreatePR: false,
      skipReviewerRequest: false,
      oasis: { sessionId: agent.sessionId || null, model: agent.model || null, folder: agent.root }
    };
  }

  async function v0Status(agent) {
    const latest = agent.runs.at(-1);
    if (!latest) return { status: 'CREATING', summary: '' };
    const view = await runView(agent, latest);
    // v0 has no CANCELLED status: a stopped agent reports FINISHED.
    const status = view.status === 'CANCELLED' ? 'FINISHED' : view.status;
    return { status, summary: view.result || '' };
  }

  async function v0View(agent, req, { summary = true } = {}) {
    const info = await v0Status(agent);
    return {
      id: agent.id,
      name: agent.name,
      status: info.status,
      source: { repository: agent.repoUrl, ...(agent.startingRef || agent.branch ? { ref: agent.startingRef || agent.branch } : {}) },
      target: { branchName: agent.branch || '', url: originOf(req) + '/app/', autoCreatePr: false, openAsCursorGithubApp: false, skipReviewerRequest: false },
      ...(summary && info.summary ? { summary: info.summary } : {}),
      createdAt: agent.createdAt
    };
  }

  // ---- validation -------------------------------------------------------------

  function promptText(prompt, field = 'prompt') {
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) fail(400, 'validation_error', field + '.text is required.');
    const text = typeof prompt.text === 'string' ? prompt.text.trim() : '';
    if (!text) fail(400, 'validation_error', field + '.text is required.');
    if (text.length > MAX_PROMPT) fail(400, 'validation_error', field + '.text is too long (12,000 characters maximum).');
    return text;
  }

  function promptImages(images, field = 'prompt') {
    if (images == null) return [];
    if (!Array.isArray(images)) fail(400, 'validation_error', field + '.images must be a list.');
    if (images.length > MAX_IMAGES) fail(400, 'validation_error', 'OASIS accepts up to ' + MAX_IMAGES + ' images per prompt.');
    return images.map((image, index) => {
      if (!image || typeof image !== 'object') fail(400, 'validation_error', field + '.images[' + index + '] must be an object.');
      if (image.url) fail(400, 'validation_error', field + '.images[' + index + '].url is not supported: OASIS does not fetch images. Send base64 data with mimeType instead.');
      // v0 sends { data, dimension } without a type; detect it from the bytes then.
      let mediaType = String(image.mimeType || image.mediaType || '').toLowerCase();
      if (!mediaType && typeof image.data === 'string') {
        mediaType = sniffImageType(Buffer.from(image.data.slice(0, 32), 'base64')) || '';
      }
      if (typeof image.data !== 'string' || !image.data) fail(400, 'validation_error', field + '.images[' + index + '] needs base64 data.');
      return { mediaType, data: image.data, name: 'api-image-' + (index + 1) };
    });
  }

  async function resolveModel(model, { v0 = false } = {}) {
    let id = '';
    if (v0) {
      if (model != null && typeof model !== 'string') fail(400, 'invalid_model', 'model must be a string.');
      id = model || '';
    } else if (model != null) {
      if (typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string') fail(400, 'invalid_model', 'model.id is required when model is set.');
      if (Array.isArray(model.params) && model.params.length) fail(400, 'invalid_model', 'model.params is not supported. OASIS models take no Cursor parameters.');
      id = model.id;
    }
    id = String(id || '').trim();
    if (!id || id === 'default') return '';
    if (!MODEL_ID.test(id)) fail(400, 'invalid_model', 'That model ID is not valid.');
    return id;
  }

  async function resolveRepository(url, ref) {
    const active = path.resolve(getActiveRoot());
    const info = await folderInfo(active);
    const wanted = normalizeRepoUrl(url);
    if (!wanted) fail(400, 'repository_required', 'Name the repository: the git remote URL or file:// URL of the folder this server serves (see GET /v1/repositories).');
    const matches = [info.remoteUrl && normalizeRepoUrl(info.remoteUrl), 'file:' + active, 'file:' + realFolder(active)].filter(Boolean);
    const wantedReal = wanted.startsWith('file:') ? 'file:' + realFolder(wanted.slice(5)) : wanted;
    if (!matches.includes(wanted) && !matches.includes(wantedReal)) {
      fail(400, 'repository_access', 'This OASIS server serves one folder (' + info.url + '). It cannot clone or switch to another repository through this API.');
    }
    if (ref != null && ref !== '') {
      const value = String(ref);
      const sha = /^[0-9a-f]{7,40}$/i.test(value) && info.head.toLowerCase().startsWith(value.toLowerCase());
      if (value !== info.branch && !sha) fail(400, 'invalid_branch_name', 'OASIS works in the folder\'s current checkout (' + (info.branch || info.head.slice(0, 12) || 'no Git branch') + '). Check out ' + value + ' first, or omit the ref.');
    }
    return info;
  }

  function rejectUnsupported(body, fields) {
    for (const [name, unsupported, why] of fields) {
      if (Object.hasOwn(body, name) && unsupported(body[name])) fail(400, 'validation_error', '"' + name + '" is not supported by OASIS: ' + why);
    }
  }
  const nonEmpty = (value) => value != null && !(Array.isArray(value) && !value.length) && !(typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);

  // ---- starting runs ----------------------------------------------------------

  function mapStartError(error) {
    const status = Number(error && error.statusCode) || 500;
    const message = String(error && error.message || error || 'Could not start the run.').slice(0, 800);
    if (status === 409 && error.activeJob) return new CursorApiError(409, 'workspace_busy', message);
    if (status === 409) return new CursorApiError(409, 'agent_busy', message);
    if (status === 503) return new CursorApiError(503, 'model_not_configured', message);
    if (status === 429) return new CursorApiError(429, 'rate_limited', message);
    if (status >= 400 && status < 500) return new CursorApiError(400, 'validation_error', message);
    return new CursorApiError(500, 'internal_error', message);
  }

  async function startRun(agent, { text, images = [], mode = null }) {
    if (path.resolve(getActiveRoot()) !== agent.root) fail(409, 'workspace_changed', 'The server now serves a different folder than this agent\'s. Switch back to ' + agent.root + ' to continue it.');
    const run = { id: 'run-' + randomUUID(), createdAt: new Date().toISOString(), prompt: text.slice(0, 6500), pending: true };
    agent.runs.push(run);
    let permissionMode;
    if (mode === 'plan') permissionMode = 'plan';
    else if (mode === 'agent' && agent.mode === 'plan') permissionMode = 'default';
    let started;
    try {
      started = await options.startAgentJob({
        message: text,
        images: images.length ? images : undefined,
        sessionId: agent.sessionId || undefined,
        ...(permissionMode ? { permissionMode } : {}),
        ...(agent.model ? { model: agent.model } : {})
      });
    } catch (error) {
      agent.runs.pop();
      throw mapStartError(error);
    }
    delete run.pending;
    run.jobId = started.jobId;
    if (started.sessionId) agent.sessionId = started.sessionId;
    if (mode) agent.mode = mode;
    agent.updatedAt = run.createdAt;
    while (agent.runs.length > MAX_RUNS_PER_AGENT) agent.runs.shift();
    const entry = { agent, run };
    runByJob.set(run.jobId, entry);
    liveUsage.set(run.jobId, zeroUsage());
    // Pick up usage already reported and a run that ended before this point.
    const job = jobs.get(run.jobId);
    if (job) {
      for (const event of job.events) if (event.type === 'usage') addUsage(liveUsage.get(run.jobId), event.data || {});
      finalize(entry, job);
    }
    await save();
    return run;
  }

  async function createAgent(body, { v0 = false, appUrl = '' } = {}) {
    let text, images, model, repoInfo, name, agentId = null, mode = null, webhook = null, ref = null;
    if (v0) {
      text = promptText(body.prompt);
      images = promptImages(body.prompt.images);
      model = await resolveModel(body.model, { v0: true });
      const source = body.source && typeof body.source === 'object' ? body.source : null;
      if (!source) fail(400, 'repository_required', 'source.repository is required: the folder this server serves (see GET /v0/repositories).');
      if (source.prUrl) fail(400, 'validation_error', '"source.prUrl" is not supported by OASIS: it does not check out pull requests. Check out the PR branch in the served folder and pass source.repository.');
      ref = source.ref;
      repoInfo = await resolveRepository(source.repository, source.ref);
      const target = body.target && typeof body.target === 'object' ? body.target : {};
      if (target.autoCreatePr === true) fail(400, 'validation_error', '"target.autoCreatePr" is not supported by OASIS: it does not open pull requests. Review the changes and open one yourself.');
      if (target.branchName) fail(400, 'validation_error', '"target.branchName" is not supported by OASIS: it works on the folder\'s current branch. Create and check out the branch first.');
      if (body.webhook != null) {
        if (typeof body.webhook !== 'object' || Array.isArray(body.webhook)) fail(400, 'validation_error', 'webhook must be an object.');
        const url = validateWebhookUrl(body.webhook.url);
        const secret = body.webhook.secret == null ? '' : String(body.webhook.secret);
        if (secret && (secret.length < 32 || secret.length > 256)) fail(400, 'validation_error', 'webhook.secret must be 32 to 256 characters.');
        webhook = { url, secret };
      }
      name = text.replace(/\s+/g, ' ').slice(0, 100);
    } else {
      rejectUnsupported(body, [
        ['envVars', nonEmpty, 'OASIS uses the environment of the server process; set variables there.'],
        ['mcpServers', nonEmpty, 'OASIS uses the MCP servers configured on this computer (oasis mcp).'],
        ['customSubagents', nonEmpty, 'define subagents as OASIS agent files (.oasis/agents) instead.'],
        ['autoCreatePR', (value) => value === true, 'OASIS does not open pull requests. Review the changes and open one yourself.']
      ]);
      text = promptText(body.prompt);
      images = promptImages(body.prompt.images);
      model = await resolveModel(body.model);
      if (body.name != null) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) fail(400, 'validation_error', 'name must be 1 to 100 characters.');
        name = body.name.trim();
      } else name = text.replace(/\s+/g, ' ').slice(0, 100);
      if (body.mode != null && !['agent', 'plan'].includes(body.mode)) fail(400, 'validation_error', 'mode must be agent or plan.');
      mode = body.mode || null;
      if (body.env != null && (typeof body.env !== 'object' || body.env.type !== 'machine')) fail(400, 'validation_error', '"env" is not supported by OASIS except { "type": "machine" }: agents run on this computer, not in Cursor\'s cloud.');
      if (body.agentId != null) {
        if (typeof body.agentId !== 'string' || !AGENT_ID.test(body.agentId)) fail(400, 'validation_error', 'agentId must look like bc-<uuid>.');
        agentId = body.agentId.toLowerCase();
        if (state.agents.some((agent) => agent.id === agentId)) fail(409, 'agent_id_conflict', 'An agent with that agentId already exists.');
      }
      const repos = body.repos == null ? [] : body.repos;
      if (!Array.isArray(repos)) fail(400, 'validation_error', 'repos must be a list.');
      if (repos.length > 1) fail(400, 'validation_error', 'This OASIS server serves one folder, so repos takes at most one entry.');
      const repo = repos[0] || null;
      if (repo && repo.prUrl) fail(400, 'validation_error', '"repos[0].prUrl" is not supported by OASIS: it does not check out pull requests. Check out the PR branch in the served folder instead.');
      ref = repo ? repo.startingRef : null;
      // No repos means "no-repo agent" in Cursor; OASIS always has its served folder, so it uses that.
      repoInfo = repo ? await resolveRepository(repo.url, repo.startingRef) : await folderInfo(path.resolve(getActiveRoot()));
    }
    const now = new Date().toISOString();
    const agent = {
      id: agentId || 'bc-' + randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      api: v0 ? 'v0' : 'v1',
      appUrl,
      root: path.resolve(getActiveRoot()),
      repoUrl: repoInfo.url,
      branch: repoInfo.branch,
      ...(ref ? { startingRef: String(ref) } : {}),
      model: model || '',
      mode: mode || 'agent',
      sessionId: null,
      archived: false,
      runs: [],
      queued: [],
      ...(webhook ? { webhook } : {})
    };
    state.agents.push(agent);
    try { await startRun(agent, { text, images, mode }); }
    catch (error) { state.agents.splice(state.agents.indexOf(agent), 1); throw error; }
    while (state.agents.length > MAX_AGENTS) {
      const index = state.agents.findIndex((item) => !activeRun(item));
      if (index < 0) break;
      state.agents.splice(index, 1);
    }
    await save();
    return agent;
  }

  // ---- webhooks (v0 statusChange) ---------------------------------------------

  function queueWebhook(agent, run) {
    const status = run.final.status === 'ERROR' || run.final.status === 'EXPIRED' ? 'ERROR' : 'FINISHED';
    const payload = {
      event: 'statusChange',
      timestamp: new Date().toISOString(),
      id: agent.id,
      status,
      source: { repository: agent.repoUrl, ...(agent.startingRef || agent.branch ? { ref: agent.startingRef || agent.branch } : {}) },
      target: { url: agent.appUrl || '/app/', branchName: agent.branch || '' },
      ...(run.final.result ? { summary: run.final.result } : {})
    };
    const delivery = deliverWebhook(agent.webhook, Buffer.from(JSON.stringify(payload))).finally(() => pendingWebhooks.delete(delivery));
    pendingWebhooks.add(delivery);
  }

  function postOnce(url, body, headers) {
    return new Promise((resolve) => {
      const target = new URL(url);
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers: { ...headers, 'content-length': body.length }, timeout: 10000 }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
        res.on('error', () => resolve(0));
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => resolve(0));
      request.end(body);
    });
  }

  async function deliverWebhook(webhook, body) {
    const headers = {
      'content-type': 'application/json',
      'user-agent': WEBHOOK_USER_AGENT,
      'x-webhook-id': 'msg_' + randomUUID().replace(/-/g, ''),
      'x-webhook-event': 'statusChange',
      ...(webhook.secret ? { 'x-webhook-signature': webhookSignature(webhook.secret, body) } : {})
    };
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      const status = await postOnce(webhook.url, body, headers);
      if (status >= 200 && status < 300) return true;
      // Retry only what may succeed later: network failures, rate limits and server errors.
      if (status && status < 500 && status !== 429 && status !== 408) return false;
      if (attempt < retryDelays.length) await new Promise((resolve) => { const timer = setTimeout(resolve, retryDelays[attempt]); timer.unref?.(); });
    }
    return false;
  }

  // ---- job events from web.mjs ------------------------------------------------

  function onJobEvent(job, event) {
    if (!state) return;
    const entry = runByJob.get(job.id);
    if (!entry) return;
    if (event.type === 'usage') {
      const usage = liveUsage.get(job.id) || zeroUsage();
      addUsage(usage, event.data || {});
      liveUsage.set(job.id, usage);
    }
    if (['completed', 'failed', 'cancelled'].includes(event.type)) finalize(entry, job);
  }

  // ---- SSE stream -------------------------------------------------------------

  async function stream(req, res, agent, run) {
    const tag = run.id.slice(4, 12);
    const header = req.headers['last-event-id'];
    let after = 0;
    if (header != null && header !== '') {
      const match = String(header).match(/^(\d{1,12})-([0-9a-f]{8})$/i);
      if (!match || match[2].toLowerCase() !== tag) fail(400, 'invalid_last_event_id', 'That Last-Event-ID does not belong to this run.');
      after = Number(match[1]);
    }
    const first = await jobFor(run);
    if (!first.job && !run.final) fail(410, 'stream_expired', 'This run\'s events are no longer kept. Read its final state with GET /v1/agents/{id}/runs/{runId}.');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff', 'x-cursor-stream-retention-seconds': String(STREAM_RETENTION_SECONDS) });
    const write = (event, data, id) => { if (!res.writableEnded && !res.destroyed) res.write((id != null ? 'id: ' + id + '-' + tag + '\n' : '') + 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
    write('status', { runId: run.id, status: (await runView(agent, run)).status });
    let lastId = after;
    let ended = false;
    const forward = (event) => {
      lastId = Math.max(lastId, event.id);
      const data = event.data || {};
      if (event.type === 'assistant_delta' && data.text) write('assistant', { text: String(data.text) }, event.id);
      else if (event.type === 'tool_start') write('tool_call', { callId: String(data.callId || 'call-' + event.id), name: String(data.name || 'tool'), status: 'running', ...(data.args !== undefined ? { args: data.args } : {}) }, event.id);
      else if (event.type === 'tool_result') write('tool_call', { callId: String(data.callId || 'call-' + event.id), name: String(data.name || 'tool'), status: 'completed', ...(data.args !== undefined ? { args: data.args } : {}), ...(data.result !== undefined ? { result: toolResultValue(data.result) } : {}) }, event.id);
      else if (event.type === 'approval_required') write('status', { runId: run.id, status: 'RUNNING', oasis: { waitingForApproval: true, approvalId: data.approvalId || null } });
    };
    const finish = async (eventId) => {
      const view = await runView(agent, run);
      write('result', { runId: run.id, status: view.status, ...(view.result ? { text: view.result } : {}), ...(view.durationMs != null ? { durationMs: view.durationMs } : {}) }, eventId);
      write('done', {}, eventId);
      ended = true;
      res.end();
    };
    req.on('close', () => { ended = true; });
    while (!ended) {
      const { job, live } = await jobFor(run);
      const events = job && Array.isArray(job.events) ? job.events.filter((event) => event.id > lastId) : [];
      for (const event of events) forward(event);
      const terminal = run.final || !job || !ACTIVE_JOB.has(job.status);
      if (terminal) { await finish(Math.max(lastId, job ? (job.nextEventId || 1) - 1 : lastId)); break; }
      if (!live) { await finish(lastId); break; }
      const before = job.nextEventId;
      await options.waitForJobEvent(job.id, HEARTBEAT_MS, req);
      if (ended) break;
      if (job.nextEventId === before && ACTIVE_JOB.has(job.status)) write('heartbeat', {});
    }
  }

  // ---- conversation (v0) ------------------------------------------------------

  async function conversation(agent) {
    let messages = [];
    if (agent.sessionId && options.loadSession) {
      try {
        const saved = await options.loadSession(agent.root, agent.sessionId, { env });
        messages = saved.messages.filter((item) => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.trim() && !item.content.startsWith('<system-reminder>'))
          .map((item, index) => ({ id: 'msg_' + String(index + 1).padStart(3, '0'), type: item.role === 'user' ? 'user_message' : 'assistant_message', text: item.content.slice(0, MAX_RESULT_CHARS) }));
      } catch { messages = []; }
    }
    if (!messages.length) {
      // Not saved yet (the first run is still going): build it from the runs.
      let n = 0;
      for (const run of agent.runs) {
        messages.push({ id: 'msg_' + String(++n).padStart(3, '0'), type: 'user_message', text: run.prompt });
        if (run.final && run.final.status === 'FINISHED' && run.final.result) messages.push({ id: 'msg_' + String(++n).padStart(3, '0'), type: 'assistant_message', text: run.final.result });
      }
    }
    return { id: agent.id, messages };
  }

  // ---- shared operations -------------------------------------------------------

  async function cancelRun(agent, run) {
    const job = run.jobId ? jobs.get(run.jobId) : null;
    if (run.final || !job || !ACTIVE_JOB.has(job.status)) fail(409, 'run_not_cancellable', 'That run is not active.');
    if (!options.cancelJob(job)) fail(409, 'run_not_cancellable', 'That run is not active.');
  }

  async function followup(agent, body, { v0 = false } = {}) {
    if (agent.archived) fail(409, 'agent_archived', 'That agent is archived. Unarchive it to continue.');
    if (!v0 && body.delivery != null) {
      if (body.delivery !== 'steer') fail(400, 'validation_error', 'delivery must be "steer" when set.');
      const extra = Object.keys(body).filter((key) => key !== 'prompt' && key !== 'delivery');
      if (extra.length) fail(400, 'validation_error', extra.map((key) => '"' + key + '"').join(', ') + (extra.length > 1 ? ' are' : ' is') + ' not allowed with delivery "steer"');
      const text = promptText(body.prompt);
      if (body.prompt.images && body.prompt.images.length) fail(400, 'validation_error', 'Images cannot be steered into a running turn; send them as a follow-up.');
      const active = activeRun(agent);
      const job = active && active.jobId ? jobs.get(active.jobId) : null;
      if (job && options.steerJob(job, text)) return { status: 202, body: { delivery: 'steered', runId: active.id } };
      if (active) {
        agent.queued = Array.isArray(agent.queued) ? agent.queued : [];
        if (agent.queued.length >= 10) fail(429, 'rate_limited', 'Too many prompts are waiting for this agent.');
        agent.queued.push({ text, images: [] });
        await save();
        return { status: 202, body: { delivery: 'queued' } };
      }
      await startRun(agent, { text });
      return { status: 202, body: { delivery: 'queued' } };
    }
    if (!v0) {
      rejectUnsupported(body, [
        ['envVars', nonEmpty, 'OASIS uses the environment of the server process; set variables there.'],
        ['mcpServers', nonEmpty, 'OASIS uses the MCP servers configured on this computer (oasis mcp).']
      ]);
      if (body.mode != null && !['agent', 'plan'].includes(body.mode)) fail(400, 'validation_error', 'mode must be agent or plan.');
      if (body.model != null) {
        const model = await resolveModel(body.model);
        if (model !== (agent.model || '')) fail(400, 'invalid_model', 'OASIS keeps one model per agent. Create a new agent to use a different model.');
      }
    }
    const text = promptText(body.prompt);
    const images = promptImages(body.prompt.images);
    if (activeRun(agent)) fail(409, 'agent_busy', 'That agent already has an active run. Wait for it to finish, cancel it, or steer it.');
    return { status: 201, run: await startRun(agent, { text, images, mode: v0 ? null : body.mode || null }) };
  }

  async function deleteAgent(agent) {
    if (activeRun(agent)) fail(409, 'agent_busy', 'That agent has an active run. Cancel it before deleting the agent.');
    if (agent.sessionId && options.deleteSession) await options.deleteSession(agent.root, agent.sessionId, { env }).catch(() => {});
    for (const run of agent.runs) if (run.jobId) runByJob.delete(run.jobId);
    state.agents.splice(state.agents.indexOf(agent), 1);
    await save();
  }

  async function setArchived(agent, archived) {
    if (archived && activeRun(agent)) fail(409, 'agent_busy', 'That agent has an active run. Cancel it before archiving.');
    if (agent.archived !== archived) {
      agent.archived = archived;
      agent.updatedAt = new Date().toISOString();
      if (agent.sessionId && options.setSessionArchived) await options.setSessionArchived(agent.root, agent.sessionId, archived, { env }).catch(() => {});
      await save();
    }
  }

  function page(items, url, { max = 100 } = {}) {
    const raw = url.searchParams.get('limit');
    const limit = raw == null || raw === '' ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) fail(400, 'validation_error', 'limit must be an integer from 1 to ' + max + '.');
    let start = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      const index = items.findIndex((item) => item.id === cursor);
      if (index < 0) fail(400, 'validation_error', 'That cursor is not valid.');
      start = index + 1;
    }
    const slice = items.slice(start, start + limit);
    return { slice, nextCursor: start + limit < items.length && slice.length ? slice.at(-1).id : null };
  }

  const newestFirst = () => [...state.agents].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));

  async function config() {
    try { return await options.getConfig(); } catch { return null; }
  }

  // ---- router -----------------------------------------------------------------

  async function route(req, res, url) {
    await load();
    const parts = url.pathname.split('/').filter(Boolean);
    const version = parts[0];
    const method = req.method;
    const body = async () => {
      const value = await options.readJsonBody(req).catch((error) => fail(Number(error.statusCode) === 413 ? 413 : 400, Number(error.statusCode) === 413 ? 'validation_error' : 'missing_body', String(error.message || 'Request body must be a JSON object.')));
      return value;
    };

    if (version === 'v1') {
      if (parts.length === 2 && parts[1] === 'me' && method === 'GET') return send(res, 200, { apiKeyName: 'OASIS web access key', createdAt: startedAt });
      if (parts.length === 2 && parts[1] === 'models' && method === 'GET') {
        const current = await config();
        const id = current && current.configured !== false && current.model ? String(current.model) : '';
        return send(res, 200, { items: id ? [{ id, displayName: id, description: 'The model OASIS is configured to use (' + String(current.protocol || 'provider') + '). Any model ID your provider accepts also works.', aliases: ['default'] }] : [] });
      }
      if (parts.length === 2 && parts[1] === 'repositories' && method === 'GET') {
        const info = await folderInfo(path.resolve(getActiveRoot()));
        return send(res, 200, { items: [{ url: info.url }] });
      }
      if (parts[1] !== 'agents') fail(404, 'not_found', 'OASIS does not implement that Cursor API endpoint.');
      if (parts.length === 2 && method === 'POST') {
        const agent = await createAgent(await body(), { appUrl: originOf(req) + '/app/' });
        return send(res, 201, { agent: agentView(agent, req), run: await runView(agent, agent.runs.at(-1)) });
      }
      if (parts.length === 2 && method === 'GET') {
        const includeArchived = !/^(false|0)$/i.test(url.searchParams.get('includeArchived') || 'true');
        const { slice, nextCursor } = page(newestFirst().filter((agent) => includeArchived || !agent.archived), url);
        return send(res, 200, { items: slice.map((agent) => agentSummary(agent, req)), ...(nextCursor ? { nextCursor } : {}) });
      }
      const agent = findAgent(parts[2]);
      if (parts.length === 3 && method === 'GET') return send(res, 200, agentView(agent, req));
      if (parts.length === 3 && method === 'DELETE') { await deleteAgent(agent); return send(res, 200, { id: agent.id }); }
      if (parts.length === 4 && (parts[3] === 'archive' || parts[3] === 'unarchive') && method === 'POST') { await setArchived(agent, parts[3] === 'archive'); return send(res, 200, { id: agent.id }); }
      if (parts.length === 4 && parts[3] === 'usage' && method === 'GET') {
        const runId = url.searchParams.get('runId');
        const runs = runId ? [findRun(agent, runId)] : [...agent.runs].reverse();
        const total = zeroUsage();
        const items = runs.map((run) => {
          const usage = run.usage || (run.jobId && liveUsage.get(run.jobId)) || zeroUsage();
          addUsage(total, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens });
          return { id: run.id, usage: { ...usage } };
        });
        return send(res, 200, { totalUsage: total, runs: items });
      }
      if (parts[3] === 'artifacts') fail(404, 'artifact_not_found', 'OASIS writes files straight into the served folder, so there are no separate artifacts to list or download.');
      if (parts[3] !== 'runs') fail(404, 'not_found', 'OASIS does not implement that Cursor API endpoint.');
      if (parts.length === 4 && method === 'POST') {
        const outcome = await followup(agent, await body());
        if (outcome.run) return send(res, 201, { run: await runView(agent, outcome.run) });
        return send(res, outcome.status, outcome.body);
      }
      if (parts.length === 4 && method === 'GET') {
        const { slice, nextCursor } = page([...agent.runs].reverse(), url);
        const items = [];
        for (const run of slice) items.push(await runView(agent, run));
        return send(res, 200, { items, ...(nextCursor ? { nextCursor } : {}) });
      }
      const run = findRun(agent, parts[4]);
      if (parts.length === 5 && method === 'GET') return send(res, 200, await runView(agent, run));
      if (parts.length === 6 && parts[5] === 'stream' && method === 'GET') return stream(req, res, agent, run);
      if (parts.length === 6 && parts[5] === 'cancel' && method === 'POST') { await cancelRun(agent, run); return send(res, 200, { id: run.id }); }
      fail(404, 'not_found', 'OASIS does not implement that Cursor API endpoint.');
    }

    // v0 (legacy)
    if (parts.length === 2 && parts[1] === 'me' && method === 'GET') return send(res, 200, { apiKeyName: 'OASIS web access key', createdAt: startedAt });
    if (parts.length === 2 && parts[1] === 'models' && method === 'GET') {
      const current = await config();
      return send(res, 200, { models: current && current.configured !== false && current.model ? [String(current.model)] : [] });
    }
    if (parts.length === 2 && parts[1] === 'repositories' && method === 'GET') {
      const info = await folderInfo(path.resolve(getActiveRoot()));
      return send(res, 200, { repositories: [{ owner: info.owner, name: info.name, repository: info.url }] });
    }
    if (parts[1] !== 'agents') fail(404, 'not_found', 'OASIS does not implement that Cursor API endpoint.');
    if (parts.length === 2 && method === 'POST') {
      const agent = await createAgent(await body(), { v0: true, appUrl: originOf(req) + '/app/' });
      return send(res, 201, await v0View(agent, req, { summary: false }));
    }
    if (parts.length === 2 && method === 'GET') {
      const { slice, nextCursor } = page(newestFirst().filter((agent) => !agent.archived), url);
      const agents = [];
      for (const agent of slice) agents.push(await v0View(agent, req));
      return send(res, 200, { agents, ...(nextCursor ? { nextCursor } : {}) });
    }
    const agent = findAgent(parts[2]);
    if (parts.length === 3 && method === 'GET') return send(res, 200, await v0View(agent, req));
    if (parts.length === 3 && method === 'DELETE') { await deleteAgent(agent); return send(res, 200, { id: agent.id }); }
    if (parts.length === 4 && parts[3] === 'conversation' && method === 'GET') return send(res, 200, await conversation(agent));
    if (parts.length === 4 && parts[3] === 'followup' && method === 'POST') { await followup(agent, await body(), { v0: true }); return send(res, 200, { id: agent.id }); }
    if (parts.length === 4 && parts[3] === 'stop' && method === 'POST') {
      const run = activeRun(agent);
      if (!run) fail(409, 'run_not_cancellable', 'That agent has no active run.');
      await cancelRun(agent, run);
      return send(res, 200, { id: agent.id });
    }
    fail(404, 'not_found', 'OASIS does not implement that Cursor API endpoint.');
  }

  async function handle(req, res, url) {
    try { await route(req, res, url); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof CursorApiError) cursorError(res, error.status, error.code, error.message);
      else cursorError(res, 500, 'internal_error', String(error && error.message || error || 'OASIS server error').slice(0, 800));
    }
  }

  return {
    handle,
    onJobEvent,
    // Bounded: a slow webhook receiver must not hold up server shutdown.
    async settle(ms = 3000) {
      await Promise.race([Promise.allSettled([...pendingWebhooks]), new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); })]);
      await writing;
    },
    storeFile
  };
}
