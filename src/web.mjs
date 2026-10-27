import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createSession, runAgentTurn, closeSession } from './agent.mjs';
import { loadConfig, saveConfig, getProviderSummary, validateProtocol, validateBaseUrl, isLoopbackUrl } from './config.mjs';
import { saveSession, loadSession, listSessions } from './sessions.mjs';
import { executeTool, resolveWorkspacePath } from './tools.mjs';
import { inspectGitHubExtension, inspectGitHubMcpServers, selectReviewedMcpServers, resolveImportedSlashCommand, installGitHubExtension, updateGitHubExtension, rollbackGitHubExtension, listInstalledExtensions, removeGitHubExtension } from './extensions.mjs';
import { loadMcpServers, saveMcpServers } from './mcp.mjs';

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


function isLoopbackBindHost(rawHost) {
  const host = String(rawHost || '127.0.0.1').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.split('.')[0] === '127';
}

function loadTlsOptions(options) {
  const hasCert = Boolean(options.tlsCertFile);
  const hasKey = Boolean(options.tlsKeyFile);
  if (hasCert !== hasKey) throw new Error('HTTPS requires both --tls-cert CERT_FILE and --tls-key KEY_FILE.');
  if (!hasCert) return null;
  const certPath = path.resolve(String(options.tlsCertFile));
  const keyPath = path.resolve(String(options.tlsKeyFile));
  try {
    const certStat = statSync(certPath);
    const keyStat = statSync(keyPath);
    if (!certStat.isFile() || !keyStat.isFile() || certStat.size < 1 || keyStat.size < 1 ||
        certStat.size > 1024 * 1024 || keyStat.size > 1024 * 1024) {
      throw new Error('TLS files must be regular files no larger than 1 MiB.');
    }
    if (process.platform !== 'win32' && (keyStat.mode & 0o077) !== 0) {
      throw new Error('TLS private-key permissions are too open. Restrict the key file to its owner (for example: chmod 600 KEY_FILE).');
    }
    return { cert: readFileSync(certPath), key: readFileSync(keyPath), minVersion: 'TLSv1.2' };
  } catch (error) {
    if (error && error.message && /TLS/.test(error.message)) throw error;
    throw new Error('Could not read the configured TLS certificate or private-key file.');
  }
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
      const expectedProtocol = req.socket && req.socket.encrypted ? 'https:' : 'http:';
      if (parsedOrigin.protocol !== expectedProtocol || parsedOrigin.host.toLowerCase() !== hostHeader.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isLoopbackClient(req) {
  const address = String(req.socket && req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  return address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address);
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
  return { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), events: [], nextEventId: 1, pendingApprovals: new Map(), controller: new AbortController(), cancelRequested: false, result: null, error: null };
}

export function createOasisWebServer(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const bindHost = options.host || '127.0.0.1';
  const tlsOptions = loadTlsOptions(options);
  if (!isLoopbackBindHost(bindHost) && !tlsOptions && options.allowInsecureLan !== true) {
    throw new Error('Binding Oasis to a non-loopback address requires HTTPS. Provide --tls-cert and --tls-key, or explicitly opt into unencrypted LAN access with --allow-insecure-lan.');
  }
  let activeRoot = root;
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
    try { return await loadConfig({ env }); }
    catch (error) {
      throw Object.assign(new Error((error && error.message || 'No model provider is configured.') + ' Run oasis setup in the terminal for this workspace, then retry.'), { statusCode: 503 });
    }
  }

  async function startAgentJob(input) {
    const incomingMessage = String(input.message || '').trim();
    if (!incomingMessage) throw Object.assign(new Error('Enter a task or question.'), { statusCode: 400 });
    if (incomingMessage.length > 12000) throw Object.assign(new Error('Message is too long (12,000 characters maximum).'), { statusCode: 413 });
    const importedCommand = incomingMessage.startsWith('/')
      ? await resolveImportedSlashCommand(activeRoot, incomingMessage, { env })
      : null;
    const message = importedCommand ? importedCommand.prompt : incomingMessage;
    if (message.length > 24000) throw Object.assign(new Error('The expanded imported command exceeds the supported prompt size.'), { statusCode: 413 });

    let sessionId = input.sessionId == null || input.sessionId === '' ? null : String(input.sessionId);
    if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) throw Object.assign(new Error('Invalid session ID.'), { statusCode: 400 });
    if (sessionId && busySessions.has(sessionId)) throw Object.assign(new Error('That session is already processing another message.'), { statusCode: 409 });

    const config = await getConfig();
    if (!config.configured) {
      throw Object.assign(new Error('No model provider is configured. Run oasis setup in the terminal for this workspace, then retry.'), { statusCode: 503 });
    }
    let session = sessionId ? activeSessions.get(sessionId) : null;
    if (session && path.resolve(session.root) !== activeRoot) session = null;
    if (sessionId && !session) {
      const restore = await loadSession(activeRoot, sessionId, { env });
      session = await createSession({ root: activeRoot, config, restore });
      activeSessions.set(sessionId, session);
    }
    if (!session) {
      session = await createSession({ root: activeRoot, config });
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
          signal: job.controller.signal,
          approval: (prompt) => approvalFor(job, prompt),
          onText: (text) => emit(job, 'assistant_text', { text: String(text || '').slice(0, 24000) }),
          onDelta: (text) => emit(job, 'assistant_delta', { text: String(text || '').slice(0, 24000) }),
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
        if (job.cancelRequested || result.cancelled) {
          job.result.cancelled = true;
          job.status = 'cancelled';
          emit(job, 'cancelled', { message: 'Task stopped. Any actions completed before cancellation remain in the workspace.', sessionId: saved.id });
        } else {
          job.status = 'completed';
          emit(job, 'completed', job.result);
        }
      } catch (error) {
        if (job.cancelRequested || error.name === 'AbortError') {
          try {
            const saved = await saveSession(session, { env });
            if (saved.id !== activeId) {
              activeSessions.delete(activeId);
              activeSessions.set(saved.id, session);
            }
            job.result = { cancelled: true, sessionId: saved.id };
          } catch {
            job.result = { cancelled: true, sessionId: activeId, sessionSaved: false };
          }
          job.status = 'cancelled';
          job.error = null;
          emit(job, 'cancelled', { message: 'Task stopped. Any actions completed before cancellation remain in the workspace.', sessionId: job.result.sessionId });
        } else {
          job.error = String(error && error.message || error || 'Agent request failed').slice(0, 4000);
          job.status = 'error';
          emit(job, 'failed', { message: job.error });
        }
      } finally {
        busySessions.delete(activeId);
      }
    })();
    return { jobId: job.id, sessionId: activeId };
  }



  async function runReadOnlyGh(args, timeoutSeconds = 30) {
    return await executeTool('run_command', { command: 'gh', args, timeoutSeconds }, {
      root: activeRoot,
      env,
      autoApprove: true,
      maxCommandSeconds: timeoutSeconds
    });
  }

  async function getGithubStatus() {
    const result = await runReadOnlyGh(['auth', 'status', '--hostname', 'github.com'], 20);
    if (result.error) {
      return { cliAvailable: false, authenticated: false, account: null, hint: 'GitHub CLI (gh) is not available in this runtime. Install GitHub CLI on the computer running oasis web, then reconnect.' };
    }
    const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
    const accountMatch = output.match(/Logged in to github\.com account ([^\s(]+)/i);
    const authenticated = result.exitCode === 0;
    return {
      cliAvailable: true,
      authenticated,
      account: authenticated && accountMatch ? accountMatch[1].slice(0, 100) : null,
      hint: authenticated ? 'GitHub CLI authentication is available.' : 'Run gh auth login in the terminal on the computer running Oasis, then refresh this status.'
    };
  }

  async function getGithubRepos() {
    const status = await getGithubStatus();
    if (!status.cliAvailable) throw Object.assign(new Error(status.hint), { statusCode: 412 });
    if (!status.authenticated) throw Object.assign(new Error(status.hint), { statusCode: 412 });
    const args = [
      'api', 'user/repos?per_page=30&sort=updated',
      '--jq', '[.[] | {nameWithOwner: .full_name, name: .name, url: .html_url, isPrivate: .private}]'
    ];
    const result = await runReadOnlyGh(args, 30);
    if (result.error || result.exitCode !== 0) {
      throw Object.assign(new Error('Could not list GitHub repositories. ' + String(result.stderr || result.error || result.stdout || 'GitHub CLI request failed').slice(0, 1800)), { statusCode: 502 });
    }
    let repositories;
    try { repositories = JSON.parse(result.stdout || '[]'); }
    catch { throw Object.assign(new Error('GitHub CLI returned invalid repository JSON. Update GitHub CLI and try again.'), { statusCode: 502 }); }
    if (!Array.isArray(repositories)) throw Object.assign(new Error('GitHub CLI returned an unexpected repository list.'), { statusCode: 502 });
    return { repositories: repositories.filter((repo) => repo && typeof repo.nameWithOwner === 'string').slice(0, 30), source: 'GitHub CLI', limit: 30 };
  }

  async function startGithubCloneJob(input) {
    const repository = String(input.repository || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) {
      throw Object.assign(new Error('Choose a repository in owner/name format from the GitHub list.'), { statusCode: 400 });
    }
    const status = await getGithubStatus();
    if (!status.cliAvailable || !status.authenticated) throw Object.assign(new Error(status.hint), { statusCode: 412 });
    if ([...jobs.values()].some((job) => job.status === 'running' || job.status === 'waiting_approval') || busySessions.size) {
      throw Object.assign(new Error('Wait until the current agent or terminal task finishes before switching workspaces.'), { statusCode: 409 });
    }

    const [owner, name] = repository.split('/');
    const relative = '.oasis/workspaces/' + owner + '--' + name;
    const resolved = await resolveWorkspacePath(root, relative, { rejectSymlinks: true });
    try {
      await access(resolved.absolute);
      const check = await executeTool('run_command', {
        command: 'git',
        args: ['-C', resolved.absolute, 'remote', 'get-url', 'origin'],
        timeoutSeconds: 10
      }, { root, env, autoApprove: true, maxCommandSeconds: 10 });
      const remote = String(check.stdout || '').trim().replace(/\.git$/i, '').replace(/\/$/, '');
      const expected = 'https://github.com/' + repository;
      const ssh = 'git@github.com:' + repository;
      if (check.exitCode !== 0 || (remote.toLowerCase() !== expected.toLowerCase() && remote.toLowerCase() !== ssh.toLowerCase())) {
        throw Object.assign(new Error('The destination workspace already exists but its GitHub origin does not match ' + repository + '. No files were changed.'), { statusCode: 409 });
      }
      activeRoot = resolved.absolute;
      return { reused: true, workspaceName: path.basename(activeRoot), workspacePath: activeRoot };
    } catch (error) {
      if (error.statusCode) throw error;
      if (error.code !== 'ENOENT') throw error;
    }

    pruneJobs();
    const job = newJob();
    job.type = 'github-clone';
    jobs.set(job.id, job);
    emit(job, 'github_clone_started', { repository });
    void (async () => {
      try {
        const approved = await approvalFor(job,
          'Clone GitHub repository ' + repository + ' into the Oasis-managed workspace ' + relative + '? This downloads repository files but does not run its scripts. Inspect repository contents before running project commands.');
        if (!approved) {
          job.result = { approved: false, repository, message: 'Clone was denied. No repository was downloaded.' };
          job.status = 'completed';
          emit(job, 'completed', job.result);
          return;
        }
        await mkdir(path.dirname(resolved.absolute), { recursive: true });
        const stagingRelative = relative + '.clone-' + job.id;
        const staging = await resolveWorkspacePath(root, stagingRelative, { rejectSymlinks: true });
        const result = await executeTool('run_command', {
          command: 'gh',
          args: ['repo', 'clone', repository, staging.absolute],
          timeoutSeconds: 600
        }, { root, env, autoApprove: true, maxCommandSeconds: 600 });
        const output = [result.stdout || '', result.stderr ? '\n' + result.stderr : '', result.error ? '\n' + result.error : ''].join('').slice(-12000);
        const cleanStaging = async () => {
          try {
            const safeStaging = await resolveWorkspacePath(root, stagingRelative, { rejectSymlinks: true });
            await rm(safeStaging.absolute, { recursive: true, force: true });
          } catch { /* Never follow or remove an unsafe/symlinked path during cleanup. */ }
        };
        if (result.exitCode === 0 && !result.error) {
          try {
            const safeTarget = await resolveWorkspacePath(root, relative, { rejectSymlinks: true });
            try {
              await access(safeTarget.absolute);
              throw Object.assign(new Error('The clone destination appeared while cloning. The new checkout was left in staging rather than replacing existing files.'), { statusCode: 409 });
            } catch (error) {
              if (error.statusCode) throw error;
              if (error.code !== 'ENOENT') throw error;
            }
            await rename(staging.absolute, safeTarget.absolute);
            activeRoot = safeTarget.absolute;
            job.result = { approved: true, repository, exitCode: 0, workspaceName: path.basename(activeRoot), workspacePath: activeRoot };
          } catch (error) {
            await cleanStaging();
            job.result = { approved: true, repository, exitCode: null, output, error: error.message, message: 'The repository was downloaded but could not be safely activated. The active workspace was not changed.' };
          }
        } else {
          await cleanStaging();
          job.result = { approved: true, repository, exitCode: result.exitCode, output, error: result.error || null, message: 'Clone failed; the active workspace was not changed.' };
        }
        emit(job, 'github_clone_result', { ...job.result, output: output || undefined });
        job.status = 'completed';
        emit(job, 'completed', job.result);
      } catch (error) {
        job.error = String(error && error.message || error || 'GitHub clone failed').slice(0, 4000);
        job.status = 'error';
        emit(job, 'failed', { jobType: 'github-clone', message: job.error });
      }
    })();
    return { jobId: job.id, jobType: 'github-clone' };
  }

  async function startTerminalJob(input) {
    const command = String(input.command || '').trim();
    if (!command || command.length > 200 || command.includes('\0')) {
      throw Object.assign(new Error('Enter one executable name or path (200 characters maximum).'), { statusCode: 400 });
    }
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\0'))) {
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
          root: activeRoot,
          env,
          autoApprove: false,
          maxCommandSeconds: timeoutSeconds,
          approval: (prompt) => approvalFor(job, prompt),
          signal: job.controller.signal
        });
        job.result = { ...result, jobType: 'terminal' };
        const output = [result.stdout || '', result.stderr ? '\n' + result.stderr : '', result.error ? '\n' + result.error : ''].join('').slice(-12000);
        emit(job, 'terminal_output', { command, exitCode: result.exitCode, approved: result.approved, output, timedOut: Boolean(result.timedOut), cancelled: Boolean(result.cancelled), message: result.message || '' });
        if (job.cancelRequested || result.cancelled) {
          job.status = 'cancelled';
          emit(job, 'cancelled', { message: 'Command stopped. Any side effects completed before cancellation remain.', jobType: 'terminal' });
        } else {
          job.status = 'completed';
          emit(job, 'completed', job.result);
        }
      } catch (error) {
        if (job.cancelRequested || error.name === 'AbortError') {
          job.status = 'cancelled';
          job.error = null;
          emit(job, 'cancelled', { message: 'Command stopped by request.', jobType: 'terminal' });
        } else {
          job.error = String(error && error.message || error || 'Command failed').slice(0, 4000);
          job.status = 'error';
          emit(job, 'failed', { jobType: 'terminal', message: job.error });
        }
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

    if (req.method === 'GET' && pathname === '/api/mcp') {
      const config = await loadMcpServers({ env });
      json(res, 200, { servers: config.servers.map((server) => ({
        name: server.name, command: server.command, args: server.args, passEnv: server.passEnv, enabled: server.enabled, origin: server.origin
      })) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/mcp') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.servers)) {
        json(res, 400, { error: 'servers must be an array of MCP server configurations.' });
        return;
      }
      let configPath;
      try { configPath = await saveMcpServers(body.servers, { env }); }
      catch (error) {
        json(res, 400, { error: String(error && error.message || error).slice(0, 2000) });
        return;
      }
      const config = await loadMcpServers({ env });
      json(res, 200, { saved: true, configPath, servers: config.servers.map((server) => ({
        name: server.name, command: server.command, args: server.args, passEnv: server.passEnv, enabled: server.enabled, origin: server.origin
      })), note: 'Saved for future agent sessions. Enabled MCP server processes start when a new coding session is created.' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/extensions') {
      json(res, 200, await listInstalledExtensions({ root: activeRoot, env }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/extensions/inspect') {
      const body = await readJsonBody(req);
      const url = String(body.url || '').trim();
      if (!url || url.length > 800) {
        json(res, 400, { error: 'Provide a GitHub repository URL no longer than 800 characters.' });
        return;
      }
      try {
        const inspected = await inspectGitHubExtension(url, { env, fetchImpl: options.fetchImpl });
        json(res, 200, inspected);
      } catch (error) {
        const message = String(error && error.message || error);
        const status = /repository home URL|public GitHub repository URL|not a valid HTTP|no importable Markdown|private repositories|only HTTP and HTTPS/i.test(message) ? 400 : (/rate-limited|returned HTTP|timed out|could not resolve/i.test(message) ? 502 : 422);
        json(res, status, { error: message.slice(0, 2500) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/extensions/mcp-import') {
      const body = await readJsonBody(req);
      const url = String(body.url || '').trim();
      const expectedCommit = String(body.expectedCommit || '');
      const serverNames = body.serverNames;
      if (!url || url.length > 800) { json(res, 400, { error: 'Provide a GitHub repository URL no longer than 800 characters.' }); return; }
      if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) { json(res, 400, { error: 'Inspect the repository first. A reviewed 40-character commit identifier is required.' }); return; }
      if (!Array.isArray(serverNames) || serverNames.length < 1 || serverNames.length > 40 ||
          serverNames.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(name)) ||
          new Set(serverNames).size !== serverNames.length) {
        json(res, 400, { error: 'Select between one and 40 valid, uniquely named MCP server proposals.' }); return;
      }
      try {
        const plan = await inspectGitHubMcpServers(url, { expectedCommit, fetchImpl: options.fetchImpl });
        let selected;
        try { selected = selectReviewedMcpServers(plan.servers, serverNames); }
        catch (error) { json(res, 409, { error: String(error && error.message || error).slice(0, 1000) }); return; }
        const current = await loadMcpServers({ env });
        const existingNames = new Set(current.servers.map((server) => server.name));
        const collisions = selected.filter((server) => existingNames.has(server.name)).map((server) => server.name);
        if (collisions.length) {
          json(res, 409, { error: 'MCP server name already configured: ' + collisions.join(', ') + '. Rename or remove the existing entry before importing.' }); return;
        }
        if (current.servers.length + selected.length > 40) { json(res, 409, { error: 'The configured MCP server limit would be exceeded.' }); return; }
        const proposed = selected.map((server) => ({ name: server.name, command: server.command, args: server.args, passEnv: [], enabled: false, origin: server.origin }));
        await saveMcpServers([...current.servers, ...proposed], { env });
        json(res, 200, {
          saved: true,
          imported: proposed.map((server) => ({ name: server.name, command: server.command, args: server.args, enabled: false, origin: server.origin })),
          source: plan.repository,
          commitSha: plan.commitSha,
          note: 'Imported MCP server declarations are disabled. No process was started. Configure required environment variables, review the command, and enable the server separately in Integrations.'
        });
      } catch (error) {
        const message = String(error && error.message || error);
        const status = /changed after inspection|already configured|limit would be exceeded/i.test(message) ? 409 :
          (/repository home URL|public GitHub repository URL|not a valid HTTP|private repositories|only HTTP and HTTPS/i.test(message) ? 400 :
          (/rate-limited|returned HTTP|timed out|could not resolve/i.test(message) ? 502 : 422));
        json(res, status, { error: message.slice(0, 2000) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/extensions/update') {
      const body = await readJsonBody(req);
      const url = String(body.url || '').trim();
      const scope = String(body.scope || 'project');
      const expectedCommit = String(body.expectedCommit || '');
      if (!url || url.length > 800) { json(res, 400, { error: 'Provide a GitHub repository URL no longer than 800 characters.' }); return; }
      if (!['self', 'project', 'both'].includes(scope)) { json(res, 400, { error: 'Scope must be self, project, or both.' }); return; }
      if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) { json(res, 400, { error: 'Inspect the repository first. A reviewed 40-character commit identifier is required.' }); return; }
      try {
        const result = await updateGitHubExtension(url, { root: activeRoot, env, scope, expectedCommit, fetchImpl: options.fetchImpl });
        json(res, 200, {
          updated: result.updated, alreadyCurrent: result.alreadyCurrent,
          extensionName: result.extensionName, scope: result.scope, commitSha: result.commitSha,
          oldCommits: result.oldCommits,
          backups: (result.backups || []).map((item) => ({ scope: item.scope, commitSha: item.commitSha })),
          importedFiles: result.importedFiles || 0, commands: result.commands || [],
          note: result.alreadyCurrent ? 'The installed extension already matches the reviewed commit.' : 'The new extension revision was installed. The previous verified revision is kept in the local rollback history.'
        });
      } catch (error) {
        const message = String(error && error.message || error);
        const status = /not installed|already current/i.test(message) ? 409 :
          (/repository home URL|public GitHub repository URL|not a valid HTTP|private repositories|only HTTP and HTTPS|scope must/i.test(message) ? 400 :
          (/rate-limited|returned HTTP|timed out|could not resolve/i.test(message) ? 502 : 422));
        json(res, status, { error: message.slice(0, 2500) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/extensions/install') {
      const body = await readJsonBody(req);
      const url = String(body.url || '').trim();
      const scope = String(body.scope || 'project');
      const expectedCommit = String(body.expectedCommit || '');
      if (!url || url.length > 800) {
        json(res, 400, { error: 'Provide a GitHub repository URL no longer than 800 characters.' });
        return;
      }
      if (!['self', 'project', 'both'].includes(scope)) {
        json(res, 400, { error: 'Scope must be self, project, or both.' });
        return;
      }
      if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) {
        json(res, 400, { error: 'Inspect the repository first. A reviewed 40-character commit identifier is required before installation.' });
        return;
      }
      try {
        const result = await installGitHubExtension(url, { root: activeRoot, env, scope, expectedCommit });
        json(res, 200, result);
      } catch (error) {
        const message = String(error && error.message || error);
        const status = /changed after inspection|already exists|destination|outside its permitted scope/i.test(message) ? 409 : (/rate-limited|returned HTTP|timed out|could not resolve/i.test(message) ? 502 : 422);
        json(res, status, { error: message.slice(0, 2500) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/extensions/rollback') {
      const body = await readJsonBody(req);
      const name = String(body.name || '');
      const scope = String(body.scope || 'project');
      const commitSha = String(body.commitSha || '');
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) { json(res, 400, { error: 'Choose a valid installed extension name.' }); return; }
      if (!['self', 'project', 'both'].includes(scope)) { json(res, 400, { error: 'Scope must be self, project, or both.' }); return; }
      if (!/^[a-f0-9]{40}$/i.test(commitSha)) { json(res, 400, { error: 'Rollback requires a full 40-character commit SHA from the available backup list.' }); return; }
      try {
        const result = await rollbackGitHubExtension({ root: activeRoot, env, scope, name, commitSha });
        json(res, 200, {
          rolledBack: result.rolledBack, alreadyCurrent: result.alreadyCurrent,
          name: result.name, scope: result.scope, commitSha: result.commitSha,
          previousCommits: result.previousCommits, backups: result.backups,
          note: result.alreadyCurrent ? 'The requested revision is already active.' : 'Rollback completed. The previously active verified revision was retained in history.'
        });
      } catch (error) {
        const message = String(error && error.message || error);
        const status = /valid installed extension name|full 40-character/i.test(message) ? 400 :
          (/No rollback history|No intact rollback backup|not found|ENOENT/i.test(message) ? 404 :
          (/modified|unexpected|outside|regular file|regular directory|manifest/i.test(message) ? 409 : 422));
        json(res, status, { error: message.slice(0, 2500) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/extensions/remove') {
      const body = await readJsonBody(req);
      const scope = String(body.scope || '');
      const name = String(body.name || '');
      if (!['self', 'project'].includes(scope) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        json(res, 400, { error: 'Choose a valid installed extension name and scope.' });
        return;
      }
      try {
        json(res, 200, await removeGitHubExtension({ root: activeRoot, env, scope, name }));
      } catch (error) {
        const message = String(error && error.message || error);
        json(res, /not installed/i.test(message) ? 404 : 409, { error: message.slice(0, 2500) });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      let provider = null;
      let providerConfigured = false;
      let setupHint = '';
      try {
        const config = await getConfig();
        provider = { ...getProviderSummary(config), baseURL: config.baseURL };
        providerConfigured = Boolean(config.configured);
        if (!providerConfigured) setupHint = 'No model API key is configured for the selected provider. Run oasis setup in the terminal, or configure OASIS_API_KEY in the runtime environment.';
      } catch (error) {
        providerConfigured = false;
        setupHint = error.message || 'Run oasis setup in the terminal.';
      }
      json(res, 200, {
        connected: true,
        providerConfigured,
        provider: provider ? { provider: provider.provider, protocol: provider.protocol, model: provider.model, baseURL: provider.baseURL, authentication: provider.authentication } : null,
        providerSetupAvailable: isLoopbackClient(req),
        workspaceName: path.basename(activeRoot),
        workspacePath: activeRoot,
        workspaceAccess: 'local-filesystem',
        approvalMode: 'per-action',
        setupHint
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/provider/config') {
      // Provider credentials may only be submitted over the local loopback connection.
      // The remote-device HTTP bridge is intentionally not allowed to receive API keys.
      if (!isLoopbackClient(req)) {
        json(res, 403, { error: 'Provider setup is available only from the same device over localhost. Do not send model API keys over the unencrypted phone-to-computer HTTP bridge.' });
        return;
      }
      const body = await readJsonBody(req);
      let protocol;
      let baseURL;
      try {
        protocol = validateProtocol(body.protocol);
        const defaultBaseURL = protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
        baseURL = validateBaseUrl(String(body.baseURL || defaultBaseURL).trim());
      } catch (error) {
        json(res, 400, { error: String(error && error.message || 'Invalid provider configuration.').slice(0, 1000) });
        return;
      }
      const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? 'gpt-6.1-sol' : '');
      const model = String(body.model || defaultModel).trim();
      const apiKey = String(body.apiKey || '').trim();
      if (!model || model.length > 200) {
        json(res, 400, { error: 'Enter a model name no longer than 200 characters.' });
        return;
      }
      if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
        json(res, 400, { error: 'The API key is invalid or too long.' });
        return;
      }
      if (!isLoopbackUrl(baseURL) && !apiKey) {
        json(res, 400, { error: 'Enter an API key for a remote provider. Local loopback providers may omit the key.' });
        return;
      }
      await saveConfig({ protocol, baseURL, model, apiKey }, { env });
      json(res, 200, {
        saved: true,
        provider: { protocol, provider: new URL(baseURL).host, model, authentication: apiKey ? 'API key configured' : (isLoopbackUrl(baseURL) ? 'local endpoint; no API key required' : 'not configured') },
        note: 'The API key is stored in the local Oasis configuration file and is never returned by this endpoint.'
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/github/status') {
      json(res, 200, await getGithubStatus());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/github/repos') {
      json(res, 200, await getGithubRepos());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/github/clone') {
      const body = await readJsonBody(req);
      const result = await startGithubCloneJob(body);
      json(res, 202, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/workspace/reset') {
      if ([...jobs.values()].some((job) => job.status === 'running' || job.status === 'waiting_approval') || busySessions.size) {
        json(res, 409, { error: 'Wait until the current agent or terminal task finishes before switching workspaces.' });
        return;
      }
      activeRoot = root;
      json(res, 200, { workspaceName: path.basename(activeRoot), workspacePath: activeRoot, reset: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      json(res, 200, { sessions: await listSessions(activeRoot, { env }) });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]{20,80})$/i);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      const saved = await loadSession(activeRoot, id, { env });
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

    const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/i);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      if (!['running', 'waiting_approval'].includes(job.status)) {
        json(res, 409, { error: 'Only a running or approval-blocked job can be cancelled.', status: job.status });
        return;
      }
      if (!job.cancelRequested) {
        job.cancelRequested = true;
        emit(job, 'cancel_requested', { message: 'Cancellation requested.' });
        job.controller.abort(new Error('Cancelled by the user.'));
        for (const pending of [...job.pendingApprovals.values()]) pending.resolve(false);
      }
      json(res, 202, { cancelRequested: true, status: job.status });
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

  const requestHandler = (req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, { error: String(error && error.message || error || 'Oasis server error').slice(0, 3000) });
    });
  };
  const server = tlsOptions ? createHttpsServer(tlsOptions, requestHandler) : createHttpServer(requestHandler);

  return {
    server,
    token,
    root,
    secure: Boolean(tlsOptions),
    async close() {
      for (const job of jobs.values()) {
        job.cancelRequested = true;
        job.controller.abort(new Error('Oasis web server is closing.'));
        for (const pending of job.pendingApprovals.values()) pending.resolve(false);
      }
      for (const session of activeSessions.values()) closeSession(session);
      activeSessions.clear();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

export async function startOasisWebServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const app = createOasisWebServer({ ...options, host });
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
