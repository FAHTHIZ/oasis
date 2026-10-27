import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createSession, runAgentTurn, closeSession } from './agent.mjs';
import { loadConfig, getProviderSummary } from './config.mjs';
import { saveSession, loadSession, listSessions } from './sessions.mjs';
import { executeTool } from './tools.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 32 * 1024;
const MAX_JOBS = 20;
const MAX_EVENTS_PER_JOB = 120;
const SESSION_ID_PATTERN = /^[a-f0-9-]{20,80}$/i;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/assets/oasis-icon.svg', ['assets/oasis-icon.svg', 'image/svg+xml']]
]);

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(body);
}

function hostIsLocalLiteral(req) {
  try {
    const hostHeader = String(req.headers.host || '');
    if (!hostHeader || hostHeader.length > 255) return false;
    const url = new URL('http://' + hostHeader);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLocal = hostname === 'localhost' || isIP(hostname) > 0;
    if (!isLocal) return false;
    const origin = req.headers.origin;
    if (origin) {
      const parsedOrigin = new URL(String(origin));
      if (parsedOrigin.protocol !== 'http:' || parsedOrigin.host.toLowerCase() !== hostHeader.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasValidToken(req, token) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  }
  return value;
}

function summarizeToolResult(result) {
  let text;
  try { text = JSON.stringify(result); } catch { text = String(result); }
  return text.length > 5000 ? text.slice(0, 5000) + '… [truncated]' : text;
}

function newJob() {
  return { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), events: [], nextEventId: 1, pendingApprovals: new Map(), result: null, error: null };
}

export function createOasisWebServer(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const token = options.token || randomBytes(32).toString('base64url');
  const activeSessions = new Map();
  const jobs = new Map();
  const busySessions = new Set();

  function emit(job, type, data = {}) {
    job.events.push({ id: job.nextEventId++, type, data, at: new Date().toISOString() });
    if (job.events.length > MAX_EVENTS_PER_JOB) job.events.splice(0, job.events.length - MAX_EVENTS_PER_JOB);
  }

  function approvalFor(job, prompt) {
    return new Promise((resolve) => {
      const approvalId = randomUUID();
      let settled = false;
      const finish = (approved) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.pendingApprovals.delete(approvalId);
        if (job.pendingApprovals.size === 0 && job.status === 'waiting_approval') job.status = 'running';
        emit(job, 'approval_resolved', { approvalId, approved: Boolean(approved) });
        resolve(Boolean(approved));
      };
      const timer = setTimeout(() => finish(false), 5 * 60 * 1000);
      timer.unref?.();
      job.pendingApprovals.set(approvalId, { resolve: finish, prompt: String(prompt).slice(0, 5000) });
      job.status = 'waiting_approval';
      emit(job, 'approval_required', { approvalId, prompt: String(prompt).slice(0, 5000), expiresInSeconds: 300 });
    });
  }

  function pruneJobs() {
    if (jobs.size < MAX_JOBS) return;
    for (const [id, job] of jobs) {
      if (jobs.size < MAX_JOBS) break;
      if (job.status === 'running' || job.status === 'waiting_approval') continue;
      jobs.delete(id);
    }
  }

  async function getConfig() {
    return await loadConfig({ env });
  }

  async function startAgentJob(input) {
    const message = String(input.message || '').trim();
    if (!message) throw Object.assign(new Error('Enter a task or question.'), { statusCode: 400 });
    if (message.length > 12000) throw Object.assign(new Error('Message is too long (12,000 characters maximum).'), { statusCode: 413 });

    let sessionId = input.sessionId == null || input.sessionId === '' ? null : String(input.sessionId);
    if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) throw Object.assign(new Error('Invalid session ID.'), { statusCode: 400 });
    if (sessionId && busySessions.has(sessionId)) throw Object.assign(new Error('That session is already processing another message.'), { statusCode: 409 });

    const config = await getConfig();
    let session = sessionId ? activeSessions.get(sessionId) : null;
    if (sessionId && !session) {
      const restore = await loadSession(root, sessionId, { env });
      session = await createSession({ root, config, restore });
      activeSessions.set(sessionId, session);
    }
    if (!session) {
      session = await createSession({ root, config });
      const temporaryId = randomUUID();
      session.sessionId = temporaryId;
      activeSessions.set(temporaryId, session);
      sessionId = temporaryId;
    }
    const activeId = sessionId || session.sessionId;
    busySessions.add(activeId);
    pruneJobs();
    const job = newJob();
    jobs.set(job.id, job);
    emit(job, 'started', { sessionId: activeId });
    void (async () => {
      try {
        const result = await runAgentTurn(session, message, {
          autoApprove: false,
          env,
          approval: (prompt) => approvalFor(job, prompt),
          onText: (text) => emit(job, 'assistant_text', { text: String(text || '').slice(0, 24000) }),
          onToolStart: ({ name }) => emit(job, 'tool_start', { name: String(name || 'tool').slice(0, 100) }),
          onToolResult: ({ name, result: value }) => emit(job, 'tool_result', { name: String(name || 'tool').slice(0, 100), result: summarizeToolResult(value) }),
          onUsage: (usage) => emit(job, 'usage', usage)
        });
        const saved = await saveSession(session, { env });
        if (saved.id !== activeId) {
          activeSessions.delete(activeId);
          activeSessions.set(saved.id, session);
        }
        job.result = { ...result, sessionId: saved.id };
        job.status = 'completed';
        emit(job, 'completed', job.result);
      } catch (error) {
        job.error = String(error && error.message || error || 'Agent request failed').slice(0, 4000);
        job.status = 'error';
        emit(job, 'failed', { message: job.error });
      } finally {
        busySessions.delete(activeId);
      }
    })();
    return { jobId: job.id, sessionId: activeId };
  }


  async function startTerminalJob(input) {
    const command = String(input.command || '').trim();
    if (!command || command.length > 200 || command.includes('\\0')) {
      throw Object.assign(new Error('Enter one executable name or path (200 characters maximum).'), { statusCode: 400 });
    }
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\\0'))) {
      throw Object.assign(new Error('Arguments must be an array of up to 80 strings; each argument is limited to 5,000 characters.'), { statusCode: 400 });
    }
    const timeoutSeconds = input.timeoutSeconds === undefined ? 120 : Number(input.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 600) {
      throw Object.assign(new Error('timeoutSeconds must be an integer between 5 and 600.'), { statusCode: 400 });
    }
    pruneJobs();
    const job = newJob();
    job.type = 'terminal';
    jobs.set(job.id, job);
    emit(job, 'terminal_started', { command, args });
    void (async () => {
      try {
        const result = await executeTool('run_command', { command, args, timeoutSeconds }, {
          root,
          env,
          autoApprove: false,
          maxCommandSeconds: timeoutSeconds,
          approval: (prompt) => approvalFor(job, prompt)
        });
        job.result = { ...result, jobType: 'terminal' };
        const output = [result.stdout || '', result.stderr ? '\\n' + result.stderr : '', result.error ? '\\n' + result.error : ''].join('').slice(-12000);
        emit(job, 'terminal_output', { command, exitCode: result.exitCode, approved: result.approved, output, timedOut: Boolean(result.timedOut), message: result.message || '' });
        job.status = 'completed';
        emit(job, 'completed', job.result);
      } catch (error) {
        job.error = String(error && error.message || error || 'Command failed').slice(0, 4000);
        job.status = 'error';
        emit(job, 'failed', { jobType: 'terminal', message: job.error });
      }
    })();
    return { jobId: job.id, jobType: 'terminal' };
  }

  async function handle(req, res) {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
      const [file, contentType] = STATIC_FILES.get(pathname);
      const body = await readFile(path.join(APP_ROOT, file));
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': body.length,
        'cache-control': file === 'index.html' ? 'no-cache' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY'
      });
      res.end(body);
      return;
    }

    if (!pathname.startsWith('/api/')) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    if (!hostIsLocalLiteral(req)) {
      json(res, 421, { error: 'Oasis API accepts requests only on localhost or a literal IP address, with same-origin browser requests.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE' });
      res.end();
      return;
    }
    if (!hasValidToken(req, token)) {
      json(res, 401, { error: 'A valid Oasis connection token is required.' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      let provider = null;
      let providerConfigured = true;
      let setupHint = '';
      try { provider = getProviderSummary(await getConfig()); }
      catch (error) { providerConfigured = false; setupHint = error.message || 'Run oasis setup in the terminal.'; }
      json(res, 200, {
        connected: true,
        providerConfigured,
        provider: provider ? { provider: provider.provider, protocol: provider.protocol, model: provider.model, authentication: provider.authentication } : null,
        workspaceName: path.basename(root),
        workspaceAccess: 'local-filesystem',
        approvalMode: 'per-action',
        setupHint
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      json(res, 200, { sessions: await listSessions(root, { env }) });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]{20,80})$/i);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      const saved = await loadSession(root, id, { env });
      const messages = saved.messages.filter((item) => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.trim())
        .map((item) => ({ role: item.role, content: item.content.slice(0, 24000) }));
      json(res, 200, { id, updatedAt: saved.updatedAt, messages });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/terminal/command') {
      const body = await readJsonBody(req);
      const result = await startTerminalJob(body);
      json(res, 202, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readJsonBody(req);
      const result = await startAgentJob(body);
      json(res, 202, result);
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})$/i);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      const after = Math.max(0, Number.parseInt(parsedUrl.searchParams.get('after') || '0', 10) || 0);
      json(res, 200, {
        id: job.id,
        status: job.status,
        events: job.events.filter((event) => event.id > after),
        nextEventId: job.nextEventId,
        result: job.result,
        error: job.error
      });
      return;
    }

    const approvalMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/approval$/i);
    if (req.method === 'POST' && approvalMatch) {
      const job = jobs.get(approvalMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      const body = await readJsonBody(req);
      const approvalId = String(body.approvalId || '');
      const approved = body.approved;
      if (typeof approved !== 'boolean') { json(res, 400, { error: 'approved must be true or false.' }); return; }
      const pending = job.pendingApprovals.get(approvalId);
      if (!pending) { json(res, 404, { error: 'That approval request is no longer pending.' }); return; }
      pending.resolve(approved);
      json(res, 200, { resolved: true, approved });
      return;
    }

    json(res, 404, { error: 'Not found.' });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, { error: String(error && error.message || error || 'Oasis server error').slice(0, 3000) });
    });
  });

  return {
    server,
    token,
    root,
    async close() {
      for (const job of jobs.values()) {
        for (const pending of job.pendingApprovals.values()) pending.resolve(false);
      }
      for (const session of activeSessions.values()) closeSession(session);
      activeSessions.clear();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

export async function startOasisWebServer(options = {}) {
  const app = createOasisWebServer(options);
  const host = options.host || '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 3917;
  await new Promise((resolve, reject) => {
    const onError = (error) => { app.server.off('listening', onListening); reject(error); };
    const onListening = () => { app.server.off('error', onError); resolve(); };
    app.server.once('error', onError);
    app.server.once('listening', onListening);
    app.server.listen(port, host);
  });
  const address = app.server.address();
  return { ...app, host, port: address && typeof address === 'object' ? address.port : port };
}
