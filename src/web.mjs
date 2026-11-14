import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { formatApprovalMessage, redactApprovalSecrets } from './approval-language.mjs';
import { labelToolActivity, safeToolActivityArgs, toolActivityArtifacts, toolActivityCategory, toolActivityOutcome, toolActivityStatus, toolActivityWarning } from './tool-activity.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { clientAddress, createAuthLimiter, hostAllowed, isLoopbackAddress, parseAllowedHosts, requestIsSecure } from './remote-access.mjs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createSession, runAgentTurn, closeSession, testProviderConnection, steerSession, carryUndeliveredSteering, compactHistoryIfNeeded, MAX_STREAMED_REPLY_CHARS } from './agent.mjs';
import { MAX_STEER_CHARS } from './steering.mjs';
import { startIdleCompaction, idleCompactMinutes } from './idle-compaction.mjs';
import { loadConfig, saveConfig, getProviderSummary, validateProtocol, validateBaseUrl, isLoopbackUrl, getBaseConfigDirectory } from './config.mjs';
import { cachedUpdateCheck, updateChecksDisabled, readUpdateState, writeUpdateState, RELEASES_PAGE } from './app-update.mjs';
import { oasisVersion } from './version.mjs';
import { saveSession, loadSession, listSessions, deleteSession, saveMidTurn, settleMidTurnSave, setSessionArchived, userFacingPrompt } from './sessions.mjs';
import { executeTool, resolveWorkspacePath, sensitivePath } from './tools.mjs';
import { inspectGitHubExtension, inspectGitHubMcpServers, selectReviewedMcpServers, resolveImportedSlashCommand, installGitHubExtension, updateGitHubExtension, rollbackGitHubExtension, listInstalledExtensions, removeGitHubExtension } from './extensions.mjs';
import { loadMcpServers, saveMcpServers } from './mcp.mjs';
import { BUILTIN_COMMANDS, runBuiltinCommand, createUsageTracker, recordUsage } from './slash.mjs';
import { expandFileMentions, resolveCustomCommand, resolveSkillCommand, loadCustomCommands } from './commands.mjs';
import { visionEnabled, imageInputCapability, sniffImageType, MAX_IMAGE_BYTES } from './images.mjs';
import { loadSettings } from './settings.mjs';
import { resolveSandbox } from './sandbox.mjs';
import { estimateTokens, contextWindowSize, contextTokens as contextTokensFor } from './context.mjs';
import { PtySessionManager } from './pty-sessions.mjs';
import { createTaskHistoryStore } from './task-history-store.mjs';
import { createWorktree, finishWorktree, removeWorktree, readWorktreeDiff, readWorktreeWorkingDiff, readWorkspaceDiff, headFileVersion, inspectWorktree, mergeWorktree, isCommitIntegrated } from './worktrees.mjs';
import { createAppResolver, skillsIndex } from './app-server.mjs';
import { listWorkspaceFiles } from './workspace-files.mjs';
import { createPreviewHandler } from './web-preview.mjs';
import { atomicWriteFile } from './atomic-write.mjs';
import { connectFromPaste } from './provider-connect.mjs';
import { basicAuthToken, createCursorAgentsApi, cursorError } from './cursor-agents-api.mjs';

// The web app shows pages from the project in its own Preview tab. Told nothing,
// models end a "build me a page" task with `xdg-open index.html`.
const WEB_APP_NOTE = 'The user is working in the OASIS web app, beside this conversation. It has a Preview tab that shows HTML pages and local dev servers from this project live, and Files, Changes and Terminal tabs. To let the user try a page or app you built, tell them to open it in Preview (for example "Open Preview to try it"); do not suggest xdg-open, open, start or double-clicking a file.';

// Commands that only make sense in the terminal (the web UI has its own session picker).
const WEB_UNSUPPORTED_COMMANDS = new Set(['resume']);
// Built-ins that only make sense in the terminal; the browser explains instead of running them.
const WEB_TERMINAL_ONLY_COMMANDS = new Set(['copy', 'sandbox', 'loop', 'cd', 'test', 'exit', 'vim', 'voice', 'terminal-setup', 'keybindings', 'sounds', 'sound']);

// Compact session status for the browser: permission mode, context use, token totals.
export function webSessionState(session, env = process.env) {
  const windowSize = contextWindowSize(session.config, env);
  const contextTokens = contextTokensFor(session).tokens;
  const usage = session.webUsage || {};
  return {
    mode: session.permissions ? session.permissions.mode : 'default',
    model: String(session.config && session.config.model || '').slice(0, 200),
    contextTokens,
    contextWindow: windowSize,
    contextPercent: windowSize ? Math.min(100, Math.round(contextTokens / windowSize * 100)) : 0,
    totalTokens: Number(usage.totalTokens || 0),
    // Spend so far, subagents included (the shared budget ledger). 0 when the
    // model has no known price, such as a local model.
    costUsd: Math.max(0, Number(session.budgetLedger && session.budgetLedger.spentUsd || session.costUsd) || 0),
    costPartial: Boolean(session.budgetLedger && session.budgetLedger.unknownRequests > 0)
  };
}

function monitorText(value, max = 500) {
  return redactApprovalSecrets(String(value == null ? '' : value)).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Stable, deliberately small projection for the run monitor. It exposes lifecycle
// metadata and redacted activity, never conversation contents or worker prompts.
export function summarizeAgentRun(job) {
  if (!job || typeof job !== 'object') return null;
  const rawEvents = Array.isArray(job.events) ? job.events : [];
  // Include only allow-listed run lifecycle events from the parent job. Never
  // return arbitrary assistant text, prompts, tool results, or command output.
  const visibleRunTypes = new Set([
    'started', 'approval_required', 'approval_resolved', 'cancel_requested',
    'cancelled', 'failed', 'completed', 'interrupted', 'worktree_ready', 'worktree_merged', 'usage',
    'compaction_started', 'compaction_completed', 'context_overflow', 'context_pruned', 'stream_restarted', 'steered'
  ]);
  const agentEvents = rawEvents
    .filter((event) => event && event.data && typeof event.data === 'object' &&
      (event.type === 'agent_activity' || visibleRunTypes.has(event.type)))
    .slice(-100);
  const workers = new Map();
  const teams = new Map();
  const stateFor = {
    'agent.started': 'running',
    'agent.background_started': 'running',
    'agent.resumed': 'running',
    'task.dispatched': 'running',
    'agent.stop_requested': 'stopping',
    'agent.completed': 'completed',
    'agent.failed': 'failed',
    'agent.cancelled': 'cancelled',
    'agent.interrupted': 'interrupted'
  };
  const approvalState = { requested: 0, resolved: 0, approved: 0, denied: 0, pending: 0, interrupted: 0 };
  let totalTokens = 0;
  let hasTokenUsage = false;
  const events = agentEvents.map((event) => {
    const isAgentEvent = event.type === 'agent_activity';
    const data = event.data;
    let type = isAgentEvent ? monitorText(data.type, 80) || 'agent.event' : 'run.' + monitorText(event.type, 80);
    const agentId = monitorText(data.agent_id, 100);
    const teamId = monitorText(data.team_id, 100);
    let description = monitorText(data.description, 200);
    let detail = isAgentEvent ? monitorText(data.detail, 500) : '';
    if (!isAgentEvent) {
      if (event.type === 'started') {
        description = 'Run started';
        detail = monitorText(data.isolation || 'workspace', 80);
      } else if (event.type === 'approval_required') {
        approvalState.requested += 1;
        approvalState.pending += 1;
        description = 'Waiting for approval';
      } else if (event.type === 'approval_resolved') {
        approvalState.resolved += 1;
        approvalState.pending = Math.max(0, approvalState.pending - 1);
        if (data.approved) approvalState.approved += 1;
        else approvalState.denied += 1;
        description = data.approved ? (data.always ? 'Approval granted for this session' : 'Action approved') : 'Action denied';
      } else if (event.type === 'cancel_requested') {
        description = 'Cancellation requested';
      } else if (event.type === 'cancelled') {
        description = 'Run cancelled';
      } else if (event.type === 'interrupted') {
        description = 'Runtime restarted';
        detail = 'Worker processes and pending approvals were not restored';
      } else if (event.type === 'failed') {
        description = 'Run failed';
        detail = monitorText(data.message || job.error, 500);
      } else if (event.type === 'completed') {
        description = data.finished === false ? 'Run stopped for review' : 'Run completed';
        detail = data.verificationIncomplete ? 'Verification incomplete' : '';
      } else if (event.type === 'worktree_ready') {
        description = 'Worktree ready for review';
        const branch = monitorText(data.branch, 120);
        detail = branch ? 'Branch ' + branch : '';
      } else if (event.type === 'worktree_merged') {
        description = 'Reviewed worktree merged';
        const branch = monitorText(data.branch, 120);
        const targetBranch = monitorText(data.targetBranch, 120);
        detail = branch && targetBranch ? branch + ' → ' + targetBranch : (branch || targetBranch);
      } else if (event.type === 'compaction_started') {
        description = 'Organizing conversation context';
        const messages = Number(data.messages);
        detail = Number.isFinite(messages) && messages > 0 ? 'Preparing a shorter history from ' + Math.floor(messages) + ' older messages' : 'Preparing a shorter conversation history';
      } else if (event.type === 'compaction_completed') {
        description = 'Conversation context protected';
        const saved = Number(data.savedTokens);
        detail = Number.isFinite(saved) && saved > 0 ? 'About ' + Math.floor(saved).toLocaleString() + ' tokens freed' : 'Earlier history summarized';
        if (data.notesSaved) detail += '; continuity note saved';
      } else if (event.type === 'context_overflow') {
        description = 'Request recovered from context limit';
        const attempt = Number(data.attempt);
        detail = Number.isFinite(attempt) && attempt > 0 ? 'Retry ' + Math.floor(attempt) + ' with a smaller history' : 'Retrying with a smaller history';
      } else if (event.type === 'stream_restarted') {
        description = 'Model connection recovered';
        const attempt = Number(data.attempt);
        detail = Number.isFinite(attempt) && attempt > 0 ? 'Response restarted (retry ' + Math.floor(attempt) + ')' : 'Response restarted';
      } else if (event.type === 'context_pruned') {
        description = 'Older tool output shortened';
        const pruned = Number(data.pruned);
        detail = Number.isFinite(pruned) && pruned > 0 ? Math.floor(pruned) + ' older results reduced to make room' : 'Older output reduced to make room';
      } else if (event.type === 'usage') {
        description = 'Model usage';
        const tokens = Number(data.totalTokens);
        if (Number.isFinite(tokens) && tokens >= 0) {
          totalTokens += tokens;
          hasTokenUsage = true;
          detail = tokens.toLocaleString() + ' tokens';
        }
      }
    }
    if (teamId && !teams.has(teamId)) {
      teams.set(teamId, { id: teamId, name: teamId, status: 'active', lastActivity: event.at || data.at || '' });
    }
    if (type.startsWith('team.')) {
      const id = teamId || description;
      if (id) {
        const current = teams.get(id) || { id, name: id, status: 'active', lastActivity: event.at || data.at || '' };
        if (type === 'team.created') {
          current.name = description || current.name;
          current.description = detail;
          current.status = 'active';
        } else if (type === 'team.shutdown_requested') current.status = 'shutting_down';
        else if (type === 'team.closed') current.status = 'closed';
        current.lastActivity = event.at || data.at || current.lastActivity;
        teams.set(id, current);
      }
    }
    if (agentId) {
      const current = workers.get(agentId) || {
        id: agentId, description: agentId, status: 'unknown', teamId: '', taskId: '',
        lastActivity: event.at || data.at || '', detail: ''
      };
      if (teamId) current.teamId = teamId;
      if (description && type !== 'task.dispatched') current.description = description;
      if (type === 'task.dispatched') current.taskId = description;
      if (stateFor[type]) current.status = stateFor[type];
      current.lastActivity = event.at || data.at || current.lastActivity;
      if (detail) current.detail = detail;
      workers.set(agentId, current);
    }
    return {
      id: Number.isSafeInteger(event.id) ? event.id : 0,
      at: monitorText(event.at || data.at, 40),
      type,
      actor: monitorText(data.actor, 100) || 'main',
      agentId,
      teamId,
      description,
      detail
    };
  });
  const workerList = [...workers.values()].sort((a, b) => Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0));
  // An interrupted record is historical, not a live worker. Reflect the saved
  // terminal state in worker/team/approval counts instead of stale live state.
  if (job.status === 'interrupted') {
    const last = rawEvents.at(-1);
    const interruptedAt = monitorText((last && last.at) || job.updatedAt || job.createdAt, 40);
    for (const worker of workerList) {
      if (worker.status === 'running' || worker.status === 'stopping') {
        worker.status = 'interrupted';
        worker.detail = 'The runtime restarted; this worker process was not restored.';
        if (interruptedAt) worker.lastActivity = interruptedAt;
      }
    }
    for (const team of teams.values()) if (team.status !== 'closed') team.status = 'interrupted';
    approvalState.interrupted = approvalState.pending;
    approvalState.pending = 0;
  }
  for (const team of teams.values()) {
    const members = workerList.filter((worker) => worker.teamId === team.id);
    team.memberCount = members.length;
    team.running = members.filter((worker) => worker.status === 'running' || worker.status === 'stopping').length;
    if (team.status === 'shutting_down' && team.running === 0) team.status = 'closed';
  }
  const latestEvent = rawEvents.length ? rawEvents[rawEvents.length - 1] : null;
  const artifact = job.result && job.result.isolatedWorktree || {};
  const branch = monitorText(artifact.branch || job.worktreeBranch, 120);
  const worktreePath = monitorText(artifact.path || job.worktreePath, 180);
  const baseCommit = /^[a-f0-9]{40}$/i.test(String(artifact.baseCommit || job.worktreeBaseCommit || ''))
    ? String(artifact.baseCommit || job.worktreeBaseCommit).toLowerCase() : '';
  const usage = { totalTokens: hasTokenUsage ? totalTokens : null };
  return {
    id: monitorText(job.id, 80),
    title: monitorText(job.title || job.type || 'Coding task', 160),
    type: monitorText(job.type || 'agent', 40),
    status: monitorText(job.status || 'unknown', 40),
    sessionId: SESSION_ID_PATTERN.test(String(job.sessionId || '')) ? String(job.sessionId) : '',
    error: monitorText(job.error, 500),
    createdAt: monitorText(job.createdAt, 40),
    updatedAt: monitorText(latestEvent && latestEvent.at || job.updatedAt || job.createdAt, 40),
    workspaceName: monitorText(job.workspaceName, 160),
    isolation: monitorText(job.isolation || (job.worktreeBranch ? 'worktree' : 'workspace'), 40),
    branch, worktreePath, baseCommit,
    approvals: approvalState,
    usage,
    workerCount: workerList.length,
    runningWorkers: workerList.filter((worker) => worker.status === 'running' || worker.status === 'stopping').length,
    teamCount: teams.size,
    teams: [...teams.values()],
    workers: workerList,
    events: events.slice(-80)
  };
}

export function toolDetail(name, args = {}) {
  if (!args || typeof args !== 'object') return '';
  let detail = '';
  if (name === 'run_command') detail = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
  else if (name === 'run_shell' || name === 'powershell') detail = String(args.command || '');
  else if (name === 'task') detail = (args.subagent_type || 'general-purpose') + ': ' + (args.description || '');
  else if (args.path || args.pattern || args.query || args.url) detail = String(args.path || args.pattern || args.query || args.url);
  detail = redactApprovalSecrets(detail);
  return detail.length > 160 ? detail.slice(0, 157) + '...' : detail;
}

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 32 * 1024;
// Browser chats copied into the session store (POST /api/sessions/import).
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const TERMINAL_JOB_STATUSES = new Set(['completed', 'error', 'cancelled', 'interrupted']);
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
// Chat requests may carry pasted or dropped images (base64), so they get a
// larger, still bounded body.
export const MAX_WEB_IMAGES = 4;
// A pasted log or stack trace easily passes 12,000 characters, which was the
// old limit. 200,000 characters is about 50K tokens.
export const MAX_CHAT_MESSAGE_CHARS = 200_000;
const MAX_CHAT_BODY_BYTES = 4 * MAX_CHAT_MESSAGE_CHARS + 64 * 1024 + MAX_WEB_IMAGES * Math.ceil(MAX_IMAGE_BYTES * 4 / 3 + 1024);
const WEB_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Validates images attached in the browser: type, real file signature, size and count. */
export function validateWebImages(value, { config = {}, env = process.env } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error('images must be a list.'), { statusCode: 400 });
  if (!value.length) return [];
  if (value.length > MAX_WEB_IMAGES) throw Object.assign(new Error('Attach up to ' + MAX_WEB_IMAGES + ' images per message.'), { statusCode: 413 });
  const capability = imageInputCapability(config, env);
  if (capability.status === 'unsupported') throw Object.assign(new Error('The current model does not accept images. ' + capability.reason), { statusCode: 400 });
  return value.map((item, index) => {
    const mediaType = String(item && item.mediaType || '').toLowerCase();
    if (!WEB_IMAGE_TYPES.has(mediaType)) throw Object.assign(new Error('Image ' + (index + 1) + ' must be PNG, JPEG, GIF or WebP.'), { statusCode: 415 });
    const data = String(item.data || '');
    if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Object.assign(new Error('Image ' + (index + 1) + ' is not valid base64.'), { statusCode: 400 });
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Image ' + (index + 1) + ' is larger than ' + Math.round(MAX_IMAGE_BYTES / 1e6 * 10) / 10 + ' MB.'), { statusCode: 413 });
    if (sniffImageType(bytes) !== mediaType) throw Object.assign(new Error('Image ' + (index + 1) + ' does not look like a ' + mediaType.slice(6).toUpperCase() + ' file.'), { statusCode: 415 });
    const name = String(item.name || 'pasted-image-' + (index + 1)).replace(/[^\w. -]+/g, '_').slice(0, 80);
    return { mediaType, data, path: name };
  });
}
const MAX_FILE_PREVIEW_BYTES = 256 * 1024;
const MAX_JOBS = 20;
// A run keeps its whole event log in memory, so reopening the page mid-task
// replays every step (`?after=` resumes from any id). Only bulky, replaceable
// events are folded: runs of streamed text merge into one event, and live
// command output for a step that has finished is dropped (its result holds
// the output, and the full text stays readable at /tool-output).
const MAX_EVENTS_PER_JOB = 4000;
const FOLDABLE_EVENTS = new Set(['assistant_delta', 'tool_output', 'model_wait']);
// Merge runs of old deltas into one (keeping the run's last id, so `?after=`
// stays correct). The newest events are left as they are.
export function compactJobEvents(events, max = MAX_EVENTS_PER_JOB, keepRecent = 20) {
  const settled = Math.max(0, events.length - keepRecent);
  const finished = new Set();
  for (const event of events) if (event.type === 'tool_result' && event.data && event.data.callId) finished.add(String(event.data.callId));
  const merged = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const last = merged[merged.length - 1];
    const old = index < settled;
    if (old && event.type === 'tool_output' && finished.has(String(event.data?.callId || ''))) continue;
    if (old && event.type === 'model_wait' && last && last.type === 'model_wait') { merged[merged.length - 1] = event; continue; }
    if (old && last && last.type === 'assistant_delta' && event.type === 'assistant_delta' && merged.length - 1 < settled) {
      merged[merged.length - 1] = { ...event, data: { ...event.data, text: String(last.data?.text || '') + String(event.data?.text || '') } };
    } else if (old && last && last.type === 'reasoning_delta' && event.type === 'reasoning_delta' && !event.data?.reset && merged.length - 1 < settled) {
      merged[merged.length - 1] = { ...event, data: { ...last.data, text: String(last.data?.text || '') + String(event.data?.text || '') } };
    } else merged.push(event);
  }
  // Still too long: drop the oldest foldable events first, then the oldest of any kind.
  let excess = merged.length - max;
  for (let index = 0; excess > 0 && index < merged.length - keepRecent; index += 1) {
    if (FOLDABLE_EVENTS.has(merged[index].type)) { merged.splice(index, 1); index -= 1; excess -= 1; }
  }
  if (merged.length > max) merged.splice(0, merged.length - max);
  events.splice(0, events.length, ...merged);
  return events;
}

// The readable text of a finished tool result, for "Show full output".
// Commands give their output; anything else gives its JSON. Secrets are
// redacted as in the event log; at most 1 MB is kept per step.
const MAX_TOOL_OUTPUT_CHARS = 1_000_000;
const MAX_TOOL_OUTPUTS_PER_JOB = 400;
export function fullToolOutputText(result) {
  let text = '';
  if (result && typeof result === 'object' && (typeof result.stdout === 'string' || typeof result.stderr === 'string')) {
    text = [result.stdout, result.stderr].filter((part) => typeof part === 'string' && part).join(result.stdout && result.stderr ? '\n' : '');
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) text += (text ? '\n' : '') + '[exit ' + result.exitCode + ']';
    if (!text) text = '(no output)';
  } else if (typeof result === 'string') text = result;
  else { try { text = JSON.stringify(result, null, 2); } catch { text = String(result); } }
  text = redactApprovalSecrets(String(text ?? ''));
  return text.length > MAX_TOOL_OUTPUT_CHARS ? { text: text.slice(0, MAX_TOOL_OUTPUT_CHARS / 2) + '\n… [' + (text.length - MAX_TOOL_OUTPUT_CHARS) + ' characters left out] …\n' + text.slice(-MAX_TOOL_OUTPUT_CHARS / 2), truncated: true } : { text, truncated: false };
}
const SESSION_ID_PATTERN = /^[a-f0-9-]{20,80}$/i;
// `/` opens the app (app/). The old single-page workspace was retired in
// 1.2; its addresses redirect to the app so bookmarks keep working, and sw.js
// is a worker that removes the old offline cache.
const RETIRED_PAGES = new Set(['/classic', '/index.html']);
const STATIC_FILES = new Map([
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/assets/oasis-icon.svg', ['assets/oasis-icon.svg', 'image/svg+xml']],
  ['/assets/icons/oasis-192.png', ['assets/icons/oasis-192.png', 'image/png']],
  ['/assets/icons/oasis-512.png', ['assets/icons/oasis-512.png', 'image/png']],
  ['/assets/icons/oasis-maskable-512.png', ['assets/icons/oasis-maskable-512.png', 'image/png']],
  ['/assets/icons/apple-touch-icon.png', ['assets/icons/apple-touch-icon.png', 'image/png']],
  ['/assets/oasis-mark.svg', ['assets/oasis-mark.svg', 'image/svg+xml']],
  ['/assets/oasis-logo.svg', ['assets/oasis-logo.svg', 'image/svg+xml']],
  ['/assets/vendor/xterm.js', ['assets/vendor/xterm.js', 'text/javascript; charset=utf-8']],
  ['/assets/vendor/xterm.css', ['assets/vendor/xterm.css', 'text/css; charset=utf-8']],
  ['/assets/vendor/xterm-addon-fit.js', ['assets/vendor/xterm-addon-fit.js', 'text/javascript; charset=utf-8']]
]);

const OPTIONAL_TERMINAL_ASSETS = new Map([
  ['/assets/vendor/xterm.js', '/* Optional OASIS terminal renderer is not installed. */;'],
  ['/assets/vendor/xterm.css', '/* Optional OASIS terminal styles are not installed. */'],
  ['/assets/vendor/xterm-addon-fit.js', '/* Optional OASIS terminal fit addon is not installed. */;']
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

// A request from this computer that did not pass through a proxy. Requests a
// reverse proxy forwards also arrive from loopback, so forwarding headers make
// them remote; a local client gains nothing by sending those headers itself.
function isLoopbackClient(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
  return isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

function hasValidToken(req, token, { allowBasic = false } = {}) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  // The Cursor-compatible API (/v0, /v1) also takes Basic auth with the access key
  // as the username and an empty password, as Cursor's API does.
  const value = match ? match[1] : allowBasic ? basicAuthToken(header) : null;
  if (!value) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const MAX_TRANSCRIBE_BYTES = 12 * 1024 * 1024;

// Content-Security-Policy for the app page. Its inline scripts are allowed by hash, so
// anything injected into the page (say, through model output rendered as HTML) cannot run,
// load remote code, be framed, or send data anywhere but this server.
const cspCache = new Map();
const APP_TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

// The app page: like the workspace page, it may only talk to this runtime.
// Model calls, shell and files all go through the token-protected API.
export function appContentSecurityPolicy(body) {
  return pageContentSecurityPolicy(body).replace("frame-src 'none'", "frame-src 'self' blob:").replace("frame-ancestors 'none'", "frame-ancestors 'self'");
}

// The JavaScript sandbox frame (app/sandbox.html, an opaque-origin iframe) runs
// untrusted code in blob workers that eval it: no network, nothing else.
export const SANDBOX_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self' blob: 'unsafe-eval'; worker-src blob:; connect-src 'none'; img-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export function pageContentSecurityPolicy(body) {
  const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const key = createHash('sha256').update(html).digest('base64');
  if (cspCache.has(key)) return cspCache.get(key);
  const hashes = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(match[1] || '')) continue;
    hashes.push("'sha256-" + createHash('sha256').update(match[2], 'utf8').digest('base64') + "'");
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self' " + hashes.join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ');
  if (cspCache.size > 8) cspCache.clear();
  cspCache.set(key, policy);
  return policy;
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
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

// A saved session as the web app's timeline: prose plus the steps behind it,
// so a task reopened in another browser (or after the browser forgot it) shows
// the same execution groups as the live view instead of only the text.
export function savedSessionDisplay(messages = [], { maxEntries = 400 } = {}) {
  const display = [];
  const byCall = new Map();
  for (const item of Array.isArray(messages) ? messages : []) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.content === 'string' ? item.content : '';
    if (item.role === 'user') {
      const typed = userFacingPrompt(text);
      if (!typed) continue;
      display.push({ role: 'user', content: typed.slice(0, MAX_STREAMED_REPLY_CHARS), at: 0 });
    } else if (item.role === 'assistant') {
      const calls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      const tools = [];
      for (const call of calls) {
        const name = String(call && call.function && call.function.name || 'tool').slice(0, 100);
        let args = {};
        try { args = safeToolActivityArgs(JSON.parse(call.function.arguments || '{}')); } catch { args = {}; }
        const tool = { id: String(call && call.id || 'step_' + display.length + '_' + tools.length).slice(0, 160), name, args, label: labelToolActivity(name, args), ok: true };
        if (call && call.id) byCall.set(String(call.id), tool);
        tools.push(tool);
      }
      if (!text.trim() && !tools.length) continue;
      display.push({ role: 'assistant', content: text.slice(0, MAX_STREAMED_REPLY_CHARS), tools, at: 0 });
    } else if (item.role === 'tool') {
      const tool = byCall.get(String(item.tool_call_id || ''));
      if (!tool) continue;
      const status = toolActivityStatus(text);
      tool.ok = !/^(error|failed|denied|blocked)$/i.test(status);
      tool.label = labelToolActivity(tool.name, tool.args, text);
      const shown = redactApprovalSecrets(text);
      tool.content = shown.length > 2000 ? shown.slice(0, 2000) + '\n…' : shown;
    }
  }
  return display.slice(-maxEntries);
}

export function summarizeToolResult(result) {
  let text;
  try { text = JSON.stringify(result); } catch { text = String(result); }
  text = redactApprovalSecrets(text);
  return text.length > 5000 ? text.slice(0, 5000) + '… [truncated]' : text;
}

function newJob() {
  return { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), events: [], nextEventId: 1, toolOutputs: new Map(), pendingApprovals: new Map(), controller: new AbortController(), cancelRequested: false, result: null, error: null };
}

// Live command output, coalesced per step: one tool_output event at most
// every 80 ms per running command, and at most 256 KB streamed per step (the
// finished result and /tool-output carry the rest). Secrets are redacted.
const LIVE_OUTPUT_INTERVAL_MS = 80;
const LIVE_OUTPUT_MAX_CHARS = 256 * 1024;
export function createLiveOutputRelay(send, { intervalMs = LIVE_OUTPUT_INTERVAL_MS, maxChars = LIVE_OUTPUT_MAX_CHARS } = {}) {
  const calls = new Map();
  const flush = (callId) => {
    const entry = calls.get(callId);
    if (!entry) return;
    clearTimeout(entry.timer); entry.timer = null;
    for (const stream of ['stdout', 'stderr']) {
      if (!entry.pending[stream]) continue;
      const text = redactApprovalSecrets(entry.pending[stream]);
      entry.pending[stream] = '';
      send({ callId, stream, text, ...(entry.capped && !entry.toldCap ? { capped: true } : {}) });
      if (entry.capped) entry.toldCap = true;
    }
  };
  return {
    push(callId, stream, text) {
      let entry = calls.get(callId);
      if (!entry) { entry = { pending: { stdout: '', stderr: '' }, sent: 0, capped: false, toldCap: false, timer: null }; calls.set(callId, entry); }
      if (entry.capped) return;
      const room = maxChars - entry.sent;
      const piece = text.length > room ? text.slice(0, room) : text;
      entry.sent += piece.length;
      if (entry.sent >= maxChars) entry.capped = true;
      entry.pending[stream] += piece;
      if (!entry.timer) { entry.timer = setTimeout(() => flush(callId), intervalMs); entry.timer.unref?.(); }
    },
    finish(callId) { flush(callId); calls.delete(callId); },
    size: () => calls.size
  };
}

function rememberToolOutput(job, callId, result) {
  if (!job.toolOutputs) job.toolOutputs = new Map();
  job.toolOutputs.set(callId, fullToolOutputText(result));
  while (job.toolOutputs.size > MAX_TOOL_OUTPUTS_PER_JOB) job.toolOutputs.delete(job.toolOutputs.keys().next().value);
}

export function createOasisWebServer(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const assetRoot = path.resolve(options.assetRoot || APP_ROOT);
  const bindHost = options.host || '127.0.0.1';
  const tlsOptions = loadTlsOptions(options);
  if (!isLoopbackBindHost(bindHost) && !tlsOptions && options.allowInsecureLan !== true) {
    throw new Error('Binding Oasis to a non-loopback address requires HTTPS. Provide --tls-cert and --tls-key, or explicitly opt into unencrypted LAN access with --allow-insecure-lan.');
  }
  let activeRoot = root;
  const env = options.env || process.env;
  const token = options.token || randomBytes(32).toString('base64url');
  // Remote access: extra host names (a domain or tunnel), and whether to believe
  // X-Forwarded-* from a reverse proxy running on this computer.
  const allowedHosts = parseAllowedHosts([...(options.publicUrl ? [options.publicUrl] : []), ...(Array.isArray(options.allowedHosts) ? options.allowedHosts : parseAllowedHosts(options.allowedHosts || ''))]);
  const trustProxy = options.trustProxy === true;
  const authLimiter = options.authLimiter || createAuthLimiter();
  // The Preview panel: project files or a local dev server, sandboxed, behind its own key.
  const preview = createPreviewHandler({
    getRoot: () => activeRoot,
    loopbackOnly: isLoopbackBindHost(bindHost) && !options.publicUrl && !trustProxy,
    ownPort: () => { try { return server.address().port; } catch { return null; } }
  });
  // Managing providers, keys, updates and hardware needs a direct local
  // connection or HTTPS, so keys never cross a network in plain text.
  const canManage = (req) => isLoopbackClient(req) || requestIsSecure(req, { trustProxy });
  const activeSessions = new Map();
  const ptyManager = options.ptyManager || new PtySessionManager();
  const ptySession = { ptyManager, background: new Map() };
  const jobs = options.jobs instanceof Map ? options.jobs : new Map();
  const taskStore = createTaskHistoryStore(root, { env });
  const busySessions = new Set();
  const startingSessions = new Set();
  const busyWorkspaces = new Set();
  const startingWorkspaces = new Set();
  const ptyWorkspaceLocks = new Map();
  let reservedJobSlots = 0;

  function refreshPtyWorkspaceLocks() {
    const listed = ptyManager.list();
    const sessions = new Map((Array.isArray(listed) ? listed : Array.isArray(listed && listed.sessions) ? listed.sessions : []).map((session) => [session.id, session]));
    for (const [id, workspaceKey] of ptyWorkspaceLocks) {
      const session = sessions.get(id);
      if (!session || session.state === 'exited' || session.state === 'error') {
        ptyWorkspaceLocks.delete(id);
        busyWorkspaces.delete(workspaceKey);
      }
    }
  }

  function workspaceIsBusy(workspaceKey) {
    refreshPtyWorkspaceLocks();
    return busyWorkspaces.has(workspaceKey) || startingWorkspaces.has(workspaceKey);
  }

  // The 409 a busy workspace answers with names what holds it, so the app can
  // offer to open or stop that task instead of a dead-end message.
  function busyWorkspaceError(workspaceKey, action) {
    const live = new Set(['queued', 'running', 'waiting_approval']);
    const holder = [...jobs.values()].reverse().find((job) => job.workspaceRoot === workspaceKey && live.has(job.status));
    const terminal = !holder && [...ptyWorkspaceLocks.values()].includes(workspaceKey);
    const what = holder && holder.type === 'agent'
      ? 'OASIS is still working on "' + String(holder.title || 'another task').slice(0, 80) + '" in this folder.'
      : terminal ? 'A terminal command is still running in this folder.'
      : 'Another task is still running in this folder.';
    const error = new Error(what + ' Open that task or stop it before ' + action + '.');
    error.statusCode = 409;
    if (holder) error.activeJob = { id: holder.id, type: holder.type || '', title: String(holder.title || '').slice(0, 160), sessionId: holder.sessionId || null, status: holder.status };
    return error;
  }

  // Long-poll readers of GET /api/jobs/:id?wait=ms, woken by the next event.
  const jobWaiters = new Map();
  function wakeJobWaiters(jobId) {
    const waiting = jobWaiters.get(jobId);
    if (!waiting) return;
    jobWaiters.delete(jobId);
    for (const wake of waiting) wake();
  }
  function waitForJobEvent(jobId, ms, req) {
    return new Promise((resolve) => {
      let waiting = jobWaiters.get(jobId);
      if (!waiting) { waiting = new Set(); jobWaiters.set(jobId, waiting); }
      const done = () => {
        clearTimeout(timer);
        req.off('close', done);
        const set = jobWaiters.get(jobId);
        if (set) { set.delete(done); if (!set.size) jobWaiters.delete(jobId); }
        resolve();
      };
      const timer = setTimeout(done, ms);
      req.once('close', done);
      waiting.add(done);
    });
  }

  // Observers of every job event (the Cursor-compatible API tracks usage and run ends here).
  const jobListeners = new Set();
  function emit(job, type, data = {}) {
    const event = { id: job.nextEventId++, type, data, at: new Date().toISOString() };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS_PER_JOB) compactJobEvents(job.events);
    taskStore.schedule(job, 250);
    for (const listener of jobListeners) { try { listener(job, event); } catch { /* an observer never breaks a job */ } }
    wakeJobWaiters(job.id);
  }

  function cancelJob(job) {
    if (!job || !['running', 'waiting_approval'].includes(job.status)) return false;
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      emit(job, 'cancel_requested', { message: 'Cancellation requested.' });
      job.controller.abort(new Error('Cancelled by the user.'));
      for (const pending of [...job.pendingApprovals.values()]) pending.resolve(false);
    }
    return true;
  }

  function steerJob(job, message) {
    if (!job || !['running', 'waiting_approval'].includes(job.status) || job.cancelRequested || !job.steerTarget) return false;
    if (!steerSession(job.steerTarget, message)) return false;
    emit(job, 'steer_queued', { length: message.length });
    return true;
  }

  // meta (from the agent) can offer "always allow <rule> this session"; that
  // choice resolves to 'always', which the agent turns into a session rule.
  function approvalFor(job, prompt, forceInteractive = false, meta = {}) {
    return new Promise((resolve) => {
      const approvalId = randomUUID();
      let settled = false;
      const detail = formatApprovalMessage(prompt, meta && typeof meta === 'object' ? meta : {});
      const suggestion = meta && meta.suggestion && !forceInteractive ? String(meta.suggestion).slice(0, 300) : null;
      const finish = (approved) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.pendingApprovals.delete(approvalId);
        if (job.pendingApprovals.size === 0 && job.status === 'waiting_approval') job.status = 'running';
        const value = approved === 'always' && suggestion ? 'always' : Boolean(approved);
        emit(job, 'approval_resolved', { approvalId, approved: Boolean(value), always: value === 'always' });
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 5 * 60 * 1000);
      timer.unref?.();
      job.pendingApprovals.set(approvalId, { resolve: finish, prompt: detail.message, risky: detail.risky, suggestion });
      job.status = 'waiting_approval';
      emit(job, 'approval_required', {
        approvalId, prompt: detail.message, risky: detail.risky, expiresInSeconds: 300,
        ...(detail.diff ? { diff: detail.diff } : {}),
        ...(suggestion ? { suggestion } : {}),
        ...(meta && meta.tool ? { tool: String(meta.tool).slice(0, 100) } : {}),
        ...(meta && meta.subagent ? { subagent: String(meta.subagent).slice(0, 100) } : {})
      });
    });
  }

  function questionFor(job, question) {
    return new Promise((resolve) => {
      const questionId = randomUUID();
      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.pendingApprovals.delete(questionId);
        if (job.pendingApprovals.size === 0 && job.status === 'waiting_approval') job.status = 'running';
        emit(job, 'question_answered', { questionId, answered: Boolean(answer) });
        resolve(answer || '');
      };
      const timer = setTimeout(() => finish(''), 10 * 60 * 1000);
      timer.unref?.();
      // Shares the approval queue so cancel and status handling cover questions too.
      job.pendingApprovals.set(questionId, { resolve: (value) => finish(typeof value === 'string' ? value : ''), question });
      job.status = 'waiting_approval';
      emit(job, 'question', { questionId, ...question, expiresInSeconds: 600 });
    });
  }

  // MCP elicitation: a server asks the user to fill in a form (or open a URL) mid-call.
  // The card is built from the schema in the page; elicit() validates the answer
  // against the schema again before anything reaches the server.
  function elicitationFor(job, request = {}) {
    return new Promise((resolve) => {
      const elicitationId = randomUUID();
      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.pendingApprovals.delete(elicitationId);
        if (job.pendingApprovals.size === 0 && job.status === 'waiting_approval') job.status = 'running';
        const result = answer && typeof answer === 'object' && ['accept', 'decline', 'cancel'].includes(answer.action) ? answer : { action: 'cancel' };
        emit(job, 'elicitation_resolved', { elicitationId, action: result.action });
        resolve(result);
      };
      const timer = setTimeout(() => finish({ action: 'cancel' }), 10 * 60 * 1000);
      timer.unref?.();
      const mode = request.mode === 'url' ? 'url' : 'form';
      let url = '';
      if (mode === 'url') { try { const parsed = new URL(String(request.url || '')); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href; } catch {} }
      if (mode === 'url' && !url) { finish({ action: 'cancel' }); return; }
      const schema = mode === 'form' ? elicitationSchemaForPage(request.schema) : null;
      job.pendingApprovals.set(elicitationId, { resolve: (value) => finish(value), elicitation: { mode } });
      job.status = 'waiting_approval';
      emit(job, 'elicitation', { elicitationId, serverName: String(request.serverName || '').slice(0, 100), message: String(request.message || '').slice(0, 2000), mode, ...(url ? { url } : {}), ...(schema ? { schema } : {}), expiresInSeconds: 600 });
    });
  }

  // Connector cards (connect_service, or Settings → Connectors). The flow runs
  // here; the page shows its view and posts Connect / Not now / a token.
  const connectFlows = new Map();
  function keepFlow(flow) {
    connectFlows.set(flow.id, flow);
    // Forget settled cards after a while; the page has the final view by then.
    flow.done.then(() => { const timer = setTimeout(() => connectFlows.delete(flow.id), 30 * 60 * 1000); timer.unref?.(); });
    if (connectFlows.size > 50) for (const [id, other] of connectFlows) { if (connectFlows.size <= 50) break; if (['connected', 'failed', 'skipped'].includes(other.view().status)) connectFlows.delete(id); }
  }
  function connectorCardFor(job, flow) {
    keepFlow(flow);
    let settled = false;
    const timer = setTimeout(() => flow.skip(), 15 * 60 * 1000);
    timer.unref?.();
    const unsubscribe = flow.subscribe((view) => {
      if (settled) return;
      emit(job, 'connector_update', view);
    });
    job.pendingApprovals.set(flow.id, { resolve: () => flow.skip(), connector: true });
    job.status = 'waiting_approval';
    emit(job, 'connector_card', { ...flow.view(), expiresInSeconds: 900 });
    return flow.done.then((view) => {
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      job.pendingApprovals.delete(flow.id);
      if (job.pendingApprovals.size === 0 && job.status === 'waiting_approval') job.status = 'running';
      emit(job, 'connector_resolved', { id: flow.id, status: view.status, connector: view.connector, account: view.account, tools: view.tools.length, message: view.message });
      return view;
    });
  }

  function pruneJobs(additionalReservations = 0) {
    if (jobs.size + reservedJobSlots + additionalReservations <= MAX_JOBS) return;
    for (const [id, job] of jobs) {
      if (jobs.size + reservedJobSlots + additionalReservations <= MAX_JOBS) break;
      if (job.status === 'running' || job.status === 'waiting_approval') continue;
      jobs.delete(id);
    }
  }

  function reserveJobSlot() {
    pruneJobs(1);
    if (jobs.size + reservedJobSlots >= MAX_JOBS) {
      throw Object.assign(new Error('The Oasis browser runtime is at its 20-job limit. Wait for an active job to finish, cancel a pending job, or retry after completed job history is pruned.'), { statusCode: 429 });
    }
    reservedJobSlots++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedJobSlots = Math.max(0, reservedJobSlots - 1);
    };
  }

  async function getConfig() {
    try { return await loadConfig({ env }); }
    catch (error) {
      throw Object.assign(new Error((error && error.message || 'No model provider is configured.') + ' Choose a model under Connections, Model provider, or run oasis setup in the terminal, then retry.'), { statusCode: 503 });
    }
  }

  async function startAgentJob(input) {
    const incomingMessage = String(input.message || '').trim();
    if (!incomingMessage) throw Object.assign(new Error('Enter a task or question.'), { statusCode: 400 });
    if (incomingMessage.length > MAX_CHAT_MESSAGE_CHARS) throw Object.assign(new Error('Message is too long (' + MAX_CHAT_MESSAGE_CHARS.toLocaleString('en-US') + ' characters maximum).'), { statusCode: 413 });
    const attachedImages = validateWebImages(input.images, { config: await loadConfig({ env }).catch(() => ({})), env });
    let sessionId = input.sessionId == null || input.sessionId === '' ? null : String(input.sessionId).toLowerCase();
    if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) throw Object.assign(new Error('Invalid session ID.'), { statusCode: 400 });
    const isolation = input.isolation == null || input.isolation === '' ? 'workspace' : String(input.isolation);
    if (!['workspace', 'worktree'].includes(isolation)) throw Object.assign(new Error('Isolation must be workspace or worktree.'), { statusCode: 400 });
    if (isolation === 'worktree' && sessionId) throw Object.assign(new Error('Start a new chat for isolated worktree runs. Existing saved sessions remain available in normal workspace mode.'), { statusCode: 400 });
    if (sessionId && (busySessions.has(sessionId) || startingSessions.has(sessionId))) {
      throw Object.assign(new Error('That session is already processing another message.'), { statusCode: 409 });
    }
    const workspaceKey = path.resolve(activeRoot);
    if (workspaceIsBusy(workspaceKey)) throw busyWorkspaceError(workspaceKey, 'starting another task');
    startingWorkspaces.add(workspaceKey);
    if (sessionId) startingSessions.add(sessionId);

    let releaseJobReservation = null;
    let taskRoot = workspaceKey;
    let taskWorktree = null;
    let worktreeFinalized = false;
    const finalizeTaskWorktree = async () => {
      if (!taskWorktree || worktreeFinalized) return null;
      worktreeFinalized = true;
      try {
        const finalized = await finishWorktree(workspaceKey, taskWorktree, {
          env, message: 'OASIS browser task: ' + incomingMessage.replace(/\s+/g, ' ').slice(0, 160),
          blockSecrets: true,
          // This background commit is unattended: do not execute repository-controlled Git hooks.
          skipHooks: true
        });
        return { ...finalized, isolation: 'worktree', baseCommit: taskWorktree.base };
      } catch (error) {
        return {
          changed: true, committed: false, requiresReview: true,
          branch: taskWorktree.branch, path: taskWorktree.relative,
          isolation: 'worktree', baseCommit: taskWorktree.base,
          error: String(error && error.message || error || 'Could not finalize the isolated worktree').slice(0, 1200),
          note: 'The isolated worktree was retained for recovery; inspect it before cleanup.'
        };
      }
    };
    try {
      // Acquire the workspace lock before any asynchronous initialization can interleave with another request.
      releaseJobReservation = reserveJobSlot();
      if (isolation === 'worktree') {
        try { taskWorktree = await createWorktree(workspaceKey, 'cloud-' + incomingMessage, { env, requireClean: true }); }
        catch (error) { throw Object.assign(new Error(error.message || 'Could not create an isolated Git worktree.'), { statusCode: 409 }); }
        taskRoot = taskWorktree.path;
      }
      const importedCommand = incomingMessage.startsWith('/')
        ? await resolveImportedSlashCommand(taskRoot, incomingMessage, { env })
        : null;
      // Project, user and plugin custom commands (/name args) and skills (/skill-name args) work in
      // the browser too, like the terminal. Built-in commands keep precedence.
      const slashName = !importedCommand && (incomingMessage.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s|$)/i) || [])[1];
      const expandedCommand = slashName && !Object.hasOwn(BUILTIN_COMMANDS, slashName.toLowerCase())
        ? await expandWebSlashCommand(taskRoot, incomingMessage, env)
        : null;
      const message = importedCommand ? importedCommand.prompt : expandedCommand ? expandedCommand.prompt : incomingMessage;
      // Room for a 96 KiB skill or command body around the user's text.
      if (message.length > MAX_CHAT_MESSAGE_CHARS + 100_000) throw Object.assign(new Error('The expanded imported command exceeds the supported prompt size.'), { statusCode: 413 });

      let config = await getConfig();
      // The Cursor-compatible API can pick a model per agent; it uses the configured provider.
      if (typeof input.model === 'string' && input.model) config = { ...config, model: input.model };
    if (!config.configured) {
      throw Object.assign(new Error('No model provider is configured. Choose a model under Connections, Model provider, or run oasis setup in the terminal, then retry.'), { statusCode: 503 });
    }
    let session = sessionId ? activeSessions.get(sessionId) : null;
    if (session && path.resolve(session.root) !== taskRoot) session = null;
    if (sessionId && !session) {
      const restore = await loadSession(taskRoot, sessionId, { env });
      session = await createSession({ root: taskRoot, config, restore, env, appendSystemPrompt: input.client === 'app' ? WEB_APP_NOTE : '' });
      activeSessions.set(sessionId, session);
    }
    if (!session) {
      session = await createSession({ root: taskRoot, config, env, appendSystemPrompt: input.client === 'app' ? WEB_APP_NOTE : '' });
      const temporaryId = randomUUID();
      session.sessionId = temporaryId;
      activeSessions.set(temporaryId, session);
      sessionId = temporaryId;
    }
    const activeId = sessionId || session.sessionId;
    // The app sends its permission chip with every message (never bypass).
    const requestedMode = typeof input.permissionMode === 'string' ? input.permissionMode : '';
    if (['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'].includes(requestedMode) && session.permissions) {
      try {
        if (typeof session.permissions.setMode === 'function') session.permissions.setMode(requestedMode);
        else session.permissions.mode = requestedMode;
        if (session.webOptions) session.webOptions.permissionMode = requestedMode;
      } catch { /* the mode stays as it was */ }
    }
    const taskWorkspaceKey = path.resolve(taskRoot);
    const job = newJob();
    job.type = 'agent';
    job.title = incomingMessage.replace(/\s+/g, ' ').slice(0, 160) || 'Coding task';
    // Another device that opens this conversation mid-task shows the request it is working on.
    job.prompt = incomingMessage.slice(0, 6500);
    job.sessionId = activeId;
    job.workspaceRoot = workspaceKey;
    job.workspaceName = taskWorktree ? taskWorktree.branch : path.basename(workspaceKey);
    job.executionRoot = taskRoot;
    if (taskWorktree) {
      job.isolation = 'worktree';
      job.worktreePath = taskWorktree.relative;
      job.worktreeBranch = taskWorktree.branch;
      job.worktreeBaseCommit = taskWorktree.base;
    }
    jobs.set(job.id, job);
    // Keep worker events attached to the task that launched each worker, even if
    // the parent starts a later turn before a background worker finishes.
    if (!(session.agentRunJobs instanceof Map)) session.agentRunJobs = new Map();
    session.agentRunJobs.set(job.id, job);
    while (session.agentRunJobs.size > 100) {
      let removed = false;
      for (const [runId, candidate] of session.agentRunJobs) {
        const workerStillRunning = session.agentTasks && session.agentTasks.agents instanceof Map &&
          [...session.agentTasks.agents.values()].some((worker) => worker.runId === runId && worker.status === 'running');
        if (!workerStillRunning && !['running', 'waiting_approval'].includes(candidate.status)) {
          session.agentRunJobs.delete(runId);
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
    session.agentRunId = job.id;
    session.onAgentEvent = (agentEvent) => {
      const originRunId = String(agentEvent && agentEvent.run_id || session.agentRunId || '');
      const target = session.agentRunJobs.get(originRunId);
      if (!target) return;
      const safeEvent = {
        id: Number.isSafeInteger(agentEvent && agentEvent.id) ? agentEvent.id : 0,
        at: monitorText(agentEvent && agentEvent.at, 40),
        type: monitorText(agentEvent && agentEvent.type, 80) || 'agent.event',
        actor: monitorText(agentEvent && agentEvent.actor, 100) || 'main',
        ...(agentEvent && agentEvent.run_id ? { run_id: monitorText(agentEvent.run_id, 100) } : {}),
        ...(agentEvent && agentEvent.agent_id ? { agent_id: monitorText(agentEvent.agent_id, 100) } : {}),
        ...(agentEvent && agentEvent.team_id ? { team_id: monitorText(agentEvent.team_id, 100) } : {}),
        ...(agentEvent && agentEvent.description ? { description: monitorText(agentEvent.description, 200) } : {}),
        ...(agentEvent && agentEvent.detail ? { detail: monitorText(agentEvent.detail, 500) } : {})
      };
      emit(target, 'agent_activity', safeEvent);
    };
    startingWorkspaces.delete(workspaceKey);
    busyWorkspaces.add(taskWorkspaceKey);
    releaseJobReservation();
    releaseJobReservation = null;
    if (sessionId) startingSessions.delete(sessionId);
    busySessions.add(activeId);
    // A summary written while this conversation sat idle is cancelled (no changes) if it is still running.
    const idleCompaction = session.idleCompaction;
    session.idleCompaction = null;
    emit(job, 'started', { sessionId: activeId, isolation, ...(taskWorktree ? { branch: taskWorktree.branch, worktreePath: taskWorktree.relative, baseCommit: taskWorktree.base } : {}) });
    // Tool servers that did not start (a plugin needing an option, a missing program) are
    // otherwise invisible in the app: say so once per conversation, with the reason.
    // Servers still connecting in the background report when they finish, if this task is still running.
    const reportMcpFailures = () => {
      const mcpFailures = Array.isArray(session.mcpFailures) ? session.mcpFailures : [];
      const shown = session.mcpFailuresShown || 0;
      if (mcpFailures.length <= shown || !['running', 'waiting_approval'].includes(job.status)) return;
      emit(job, 'mcp_failures', { servers: mcpFailures.slice(shown, shown + 20).map((failure) => {
        const url = failure.config && /^https:\/\//i.test(String(failure.config.url || '')) ? String(failure.config.url).slice(0, 500) : '';
        return { name: monitorText(failure.name, 120), error: monitorText(failure.error, 300), ...(url && /needs sign-in/i.test(String(failure.error)) ? { signInUrl: url } : {}) };
      }) });
      session.mcpFailuresShown = mcpFailures.length;
    };
    reportMcpFailures();
    // A local model serving a window too small for agent work: say so once per conversation, with the fix.
    if (!session.localContextNoticesShown && Array.isArray(session.localContextNotices) && session.localContextNotices.length) {
      session.localContextNoticesShown = true;
      emit(job, 'notices', { notices: session.localContextNotices.slice(0, 3).map((note) => monitorText(note, 600)) });
    }
    if (session.mcpConnecting && typeof session.mcpConnecting.then === 'function') session.mcpConnecting.then(reportMcpFailures, () => {});
    void (async () => {
      try {
        const idleInfo = idleCompaction ? await idleCompaction.settle().catch(() => null) : null;
        if (idleInfo) emit(job, 'compaction_completed', { savedTokens: Math.max(0, (idleInfo.beforeTokens || 0) - (idleInfo.afterTokens || 0)), beforeTokens: idleInfo.beforeTokens || 0, afterTokens: idleInfo.afterTokens || 0, removedMessages: 0, notesSaved: false, usedModelSummary: true, midTurn: false, idle: true });
        let prompt = message;
        let images = [];
        let planOnly = false;
        const withAttached = (list) => [...attachedImages, ...(list || [])].slice(0, MAX_WEB_IMAGES);
        if (attachedImages.length) emit(job, 'context_files', { files: attachedImages.map((image) => image.path) });
        session.webUsage = session.webUsage || createUsageTracker();
        session.onBackgroundUsage = (usage) => { if (session.webUsage) recordUsage(session.webUsage, usage); };
        const slash = message.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i);
        if (!importedCommand && !expandedCommand && slash && Object.hasOwn(BUILTIN_COMMANDS, slash[1].toLowerCase()) && !WEB_UNSUPPORTED_COMMANDS.has(slash[1].toLowerCase())) {
          session.webOptions = session.webOptions || {};
          session.webUsage = session.webUsage || createUsageTracker();
          const slashName = slash[1].toLowerCase();
          const blockedBypass = slashName === 'mode' && /^bypasspermissions$/i.test(String(slash[2] || '').trim());
          const terminalOnly = ['copy', 'sandbox', 'loop', 'cd', 'test'].includes(slashName) || (slashName === 'mcp' && /^login\b/i.test(String(slash[2] || '').trim()));
          let commandArgument = String(slash[2] || '').trim();
          // Slash-command routing creates a new prompt, so expand explicit file
          // mentions from the arguments first; otherwise /diagnose @screenshot.png
          // would reach the model as plain text without the attachment.
          if (['init', 'plan', 'fix', 'diagnose'].includes(slashName) && commandArgument.includes('@')) {
            const capability = imageInputCapability(session.config || {}, env);
            const expanded = await expandFileMentions(taskRoot, commandArgument, { images: capability.status === 'supported' }).catch(() => null);
            if (expanded && expanded.files.length) {
              commandArgument = expanded.text;
              images = expanded.images || [];
              emit(job, 'context_files', { files: expanded.files.slice(0, 50) });
            }
          }
          let handled = slashName === 'sounds' || slashName === 'sound' ? { output: 'In the browser, sound effects play here in the page: turn them on or off and set the volume under Settings → Sound effects. /sounds in the terminal (oasis) controls terminal sounds.' } : terminalOnly && slashName === 'test' ? { output: '/test runs in the terminal (oasis). In the browser, type !npm test (or your test command): it asks for approval, and the output goes to Oasis with your next message.' } : terminalOnly ? { output: '/' + slashName + ' is available in the terminal (oasis). In the browser, copy replies from the chat and change workspaces from the workspace picker.' } : blockedBypass ? { output: 'bypassPermissions is available only in the terminal (oasis --permission-mode bypassPermissions). The browser always keeps approvals on.' } : await runBuiltinCommand(slashName, commandArgument, { root: taskRoot, session, env, usage: session.webUsage, sessionOptions: session.webOptions, confirm: (question) => approvalFor(job, question, true), askUser: (question) => questionFor(job, question) });
          // /presets N: a saved prompt becomes this turn; a saved built-in
          // /command runs once here.
          if (handled && handled.queue) {
            const queued = String(handled.queue);
            const inner = queued.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i);
            const innerName = inner ? inner[1].toLowerCase() : '';
            if (!inner) handled = { output: handled.output, prompt: queued };
            else if (Object.hasOwn(BUILTIN_COMMANDS, innerName) && !WEB_UNSUPPORTED_COMMANDS.has(innerName) && !['copy', 'sandbox', 'loop', 'cd', 'test', 'presets', 'mode'].includes(innerName)) {
              const ran = await runBuiltinCommand(innerName, String(inner[2] || '').trim(), { root: taskRoot, session, env, usage: session.webUsage, sessionOptions: session.webOptions, confirm: (question) => approvalFor(job, question, true), askUser: (question) => questionFor(job, question) });
              handled = { ...(ran || {}), output: [handled.output, ran && ran.output].filter(Boolean).join('\n\n') };
            } else handled = { output: handled.output + '\n\n/' + innerName + ' cannot run from a preset in the browser. Use the terminal (oasis), or type it here.' };
          }
          if (handled) {
            emit(job, 'command_output', { command: slash[1].toLowerCase(), text: String(handled.output || '').slice(0, 24000) });
            if (!handled.prompt) {
              const saved = await saveSession(session, { env });
              if (saved.id !== activeId) { activeSessions.delete(activeId); activeSessions.set(saved.id, session); }
              job.result = { text: String(handled.output || ''), command: slash[1].toLowerCase(), finished: true, toolCalls: 0, sessionId: saved.id };
              if (taskWorktree) {
                job.result.isolatedWorktree = await finalizeTaskWorktree();
                emit(job, 'worktree_ready', job.result.isolatedWorktree);
              }
              emit(job, 'session_state', webSessionState(session, env));
              job.status = 'completed';
              emit(job, 'completed', job.result);
              return;
            }
            prompt = handled.prompt;
            planOnly = Boolean(handled.planOnly);
          }
        }
        if (prompt === message) {
          const expanded = await expandFileMentions(taskRoot, message, { images: visionEnabled(session.config, env) }).catch(() => null);
          if (expanded && expanded.files.length) {
            prompt = expanded.text;
            images = expanded.images || [];
            emit(job, 'context_files', { files: expanded.files.slice(0, 50) });
          }
        }
        const toolActivityArgsByCallId = new Map();
        const liveOutput = createLiveOutputRelay((data) => emit(job, 'tool_output', data));
        let assistantDeltaBuffer = '';
        let reasoningBuffer = '';
        job.steerTarget = session;
        // MCP forms go to whichever browser job is running when the server asks.
        session.elicit = (request) => elicitationFor(job, request);
        const result = await runAgentTurn(session, prompt, {
          autoApprove: false,
          onVerificationGate: (gate) => emit(job, 'verification_gate', { steps: (Array.isArray(gate && gate.steps) ? gate.steps : []).slice(0, 6).map((step) => String(step).slice(0, 120)) }),
          onSteer: (info) => emit(job, 'steered', { delivered: Math.max(0, Math.min(20, Number(info && info.delivered) || 0)) }),
          ...(planOnly ? { planOnly: true } : {}),
          env,
          signal: job.controller.signal,
          ...(withAttached(images).length ? { images: withAttached(images) } : {}),
          approval: (prompt, forceInteractive, meta) => approvalFor(job, prompt, forceInteractive, meta),
          askUser: (question) => questionFor(job, question),
          connectorCard: (flow) => connectorCardFor(job, flow),
          onUsage: (usage) => { if (session.webUsage) recordUsage(session.webUsage, usage); emit(job, 'usage', usage); },
          onModelWait: (event) => {
            // Start and end of each model request: the page shows "Thinking"
            // from the moment the request goes out, not only once text arrives.
            if (event && (event.phase === 'start' || event.phase === 'end')) { emit(job, 'model_wait', { phase: event.phase, step: Number(event.step) || 1 }); return; }
            if (!event || event.phase !== 'progress' || !event.promptProgress) return;
            const p = event.promptProgress;
            emit(job, 'model_wait', { phase: 'progress', step: Number(event.step) || 1, promptProgress: { total: Number(p.total) || 0, cache: Number(p.cache) || 0, processed: Number(p.processed) || 0, time_ms: Number(p.time_ms) || 0 } });
          },
          onThinkingBudget: (budget) => emit(job, 'thinking', { budget }),
          onReasoningEffort: (effort) => emit(job, 'thinking', { effort }),
          onText: (text) => { reasoningBuffer = ''; emit(job, 'assistant_text', { text: String(text || '').slice(0, MAX_STREAMED_REPLY_CHARS) }); },
          // The model's reasoning summary as it streams (already redacted and
          // capped by the agent). A step's text replaces the one before.
          onModelTiming: (record) => emit(job, 'model_timing', record),
          onReasoning: (text) => {
            const current = String(text || '').slice(0, 8000);
            const grows = reasoningBuffer && current.startsWith(reasoningBuffer);
            const delta = grows ? current.slice(reasoningBuffer.length) : current;
            reasoningBuffer = current;
            if (delta) emit(job, 'reasoning_delta', { text: delta, ...(grows ? {} : { reset: true }) });
          },
          onDelta: (text) => {
            const current = String(text || '').slice(0, MAX_STREAMED_REPLY_CHARS);
            const delta = current.startsWith(assistantDeltaBuffer) ? current.slice(assistantDeltaBuffer.length) : current;
            assistantDeltaBuffer = current;
            if (delta) emit(job, 'assistant_delta', { text: delta });
          },
          onToolOutput: ({ call, stream, text }) => {
            const callId = call && call.id ? String(call.id).slice(0, 160) : '';
            if (callId && text) liveOutput.push(callId, stream === 'stderr' ? 'stderr' : 'stdout', String(text));
          },
          onToolStart: ({ name, args, call, subagent }) => {
            assistantDeltaBuffer = '';
            if (!subagent) reasoningBuffer = '';
            const safeArgs = safeToolActivityArgs(args);
            const callId = call && call.id ? String(call.id).slice(0, 160) : '';
            if (callId) toolActivityArgsByCallId.set(callId, { args: safeArgs, startedAt: Date.now() });
            emit(job, 'tool_start', {
              name: String(name || 'tool').slice(0, 100),
              callId,
              args: safeArgs,
              label: labelToolActivity(name, safeArgs),
              category: toolActivityCategory(name),
              detail: toolDetail(name, safeArgs),
              ...(subagent ? { subagent: String(subagent).slice(0, 100) } : {})
            });
          },
          onToolResult: ({ name, result: value, call, subagent }) => {
            // Keep finished steps on disk while the task runs, so a server
            // restart leaves a conversation that can be continued.
            saveMidTurn(session, { env });
            const callId = call && call.id ? String(call.id).slice(0, 160) : '';
            const tracked = callId ? toolActivityArgsByCallId.get(callId) : null;
            const args = tracked && tracked.args ? tracked.args : {};
            if (callId) toolActivityArgsByCallId.delete(callId);
            const artifacts = toolActivityArtifacts(name, args, value);
            if (callId) { liveOutput.finish(callId); rememberToolOutput(job, callId, value); }
            emit(job, 'tool_result', {
              name: String(name || 'tool').slice(0, 100),
              callId,
              args,
              label: labelToolActivity(name, args, value),
              category: toolActivityCategory(name),
              status: toolActivityStatus(value),
              outcome: toolActivityOutcome(value),
              ...(tracked && Number.isFinite(tracked.startedAt) ? { durationMs: Math.max(0, Date.now() - tracked.startedAt) } : {}),
              result: summarizeToolResult(value),
              warning: toolActivityWarning(value),
              ...(artifacts.length ? { artifacts, previewJobId: job.id } : {}),
              ...(subagent ? { subagent: String(subagent).slice(0, 100) } : {})
            });
          },
          onCompactionStart: (info) => emit(job, 'compaction_started', {
            messages: Math.max(0, Math.min(10000, Math.floor(Number(info && info.messages) || 0))),
            timeoutSeconds: Math.max(0, Math.min(600, Math.floor(Number(info && info.timeoutSeconds) || 0)))
          }),
          onCompaction: (info) => {
            emit(job, 'compaction_completed', {
              savedTokens: Math.max(0, Math.min(2_000_000, Math.floor(Number(info && info.savedTokens) || 0))),
              beforeTokens: Math.max(0, Math.min(2_000_000, Math.floor(Number(info && info.beforeTokens) || 0))),
              afterTokens: Math.max(0, Math.min(2_000_000, Math.floor(Number(info && info.afterTokens) || 0))),
              removedMessages: Math.max(0, Math.min(10000, Math.floor(Number(info && info.removedMessages) || 0))),
              notesSaved: Boolean(info && info.notesSaved),
              usedModelSummary: Boolean(info && info.usedModelSummary),
              midTurn: Boolean(info && info.midTurn)
            });
            emit(job, 'session_state', webSessionState(session, env));
          },
          onStreamRestart: (info) => {
            assistantDeltaBuffer = '';
            emit(job, 'stream_restarted', { attempt: Math.max(0, Math.min(5, Math.floor(Number(info && info.attempt) || 0))) });
          },
          onContextOverflow: (info) => {
            emit(job, 'context_overflow', {
              attempt: Math.max(0, Math.min(3, Math.floor(Number(info && info.attempt) || 0))),
              changed: Boolean(info && info.changed),
              beforeChars: Math.max(0, Math.min(8_000_000, Math.floor(Number(info && info.beforeChars) || 0))),
              afterChars: Math.max(0, Math.min(8_000_000, Math.floor(Number(info && info.afterChars) || 0)))
            });
            emit(job, 'session_state', webSessionState(session, env));
          },
          onContextPruned: (info) => {
            emit(job, 'context_pruned', {
              pruned: Math.max(0, Math.min(10000, Math.floor(Number(info && info.pruned) || 0))),
              before: Math.max(0, Math.min(2_000_000, Math.floor(Number(info && info.before) || 0))),
              after: Math.max(0, Math.min(2_000_000, Math.floor(Number(info && info.after) || 0))),
              midTurn: Boolean(info && info.midTurn)
            });
            emit(job, 'session_state', webSessionState(session, env));
          }
        });
        // Close the steering window before draining the queue. Notes that
        // arrived during the last model step are placed in history before save.
        job.steerTarget = null;
        const undeliveredSteering = carryUndeliveredSteering(session);
        await settleMidTurnSave(session);
        const saved = await saveSession(session, { env });
        if (saved.id !== activeId) {
          activeSessions.delete(activeId);
          activeSessions.set(saved.id, session);
        }
        job.result = { ...result, sessionId: saved.id, ...(undeliveredSteering.length ? { undeliveredSteering } : {}) };
        if (session.webUsage) session.webUsage.turns += 1;
        emit(job, 'session_state', webSessionState(session, env));
        if (job.cancelRequested || result.cancelled) {
          job.result.cancelled = true;
          if (taskWorktree) {
            job.result.isolatedWorktree = await finalizeTaskWorktree();
            emit(job, 'worktree_ready', job.result.isolatedWorktree);
          }
          job.status = 'cancelled';
          emit(job, 'cancelled', { message: 'Task stopped. Any actions completed before cancellation remain in the workspace.', sessionId: saved.id });
        } else {
          if (taskWorktree) {
            job.result.isolatedWorktree = await finalizeTaskWorktree();
            emit(job, 'worktree_ready', job.result.isolatedWorktree);
          }
          const changed = !taskWorktree && result.verification && Array.isArray(result.verification.changedPaths) ? result.verification.changedPaths : [];
          if (changed.length) {
            const { autoCommitEnabled, autoCommitTurn } = await import('./auto-commit.mjs');
            if (autoCommitEnabled(session, env)) {
              const commit = await autoCommitTurn({ root: session.root || root, paths: changed, prompt: String(prompt || '') }).catch((error) => ({ error: error.message }));
              if (commit.committed) { job.result.autoCommit = { commit: commit.committed, message: commit.subject, files: commit.files }; emit(job, 'auto_commit', job.result.autoCommit); }
              else if (commit.error) emit(job, 'auto_commit', { error: commit.error });
            }
          }
          job.status = 'completed';
          emit(job, 'completed', job.result);
        }
      } catch (error) {
        if (job.cancelRequested || error.name === 'AbortError') {
          job.steerTarget = null;
          const leftover = carryUndeliveredSteering(session);
          try {
            await settleMidTurnSave(session);
            const saved = await saveSession(session, { env });
            if (saved.id !== activeId) {
              activeSessions.delete(activeId);
              activeSessions.set(saved.id, session);
            }
            job.result = { cancelled: true, sessionId: saved.id };
          } catch {
            job.result = { cancelled: true, sessionId: activeId, sessionSaved: false };
          }
          if (leftover.length) job.result.undeliveredSteering = leftover;
          if (taskWorktree) {
            job.result.isolatedWorktree = await finalizeTaskWorktree();
            emit(job, 'worktree_ready', job.result.isolatedWorktree);
          }
          job.status = 'cancelled';
          job.error = null;
          emit(job, 'cancelled', { message: 'Task stopped. Any actions completed before cancellation remain in the workspace.', sessionId: job.result.sessionId, ...(leftover.length ? { undeliveredSteering: leftover } : {}) });
        } else {
          job.error = String(error && error.message || error || 'Agent request failed').slice(0, 4000);
          if (taskWorktree) {
            job.result = { isolatedWorktree: await finalizeTaskWorktree() };
            emit(job, 'worktree_ready', job.result.isolatedWorktree);
          }
          job.status = 'error';
          emit(job, 'failed', { message: job.error });
        }
      } finally {
        job.steerTarget = null;
        busySessions.delete(activeId);
        if (!taskWorktree && job.status === 'completed') {
          session.idleCompaction = startIdleCompaction(session, {
            minutes: idleCompactMinutes(session.settings, env),
            env,
            compact: async (target, options) => {
              if (busySessions.has(activeId)) return { compacted: false };
              const before = estimateTokens(target.messages);
              const outcome = await compactHistoryIfNeeded(target, { ...options, mustPreserve: target.mustPreserve });
              if (!outcome || !outcome.compacted) return outcome;
              await saveSession(target, { env }).catch((error) => process.stderr.write('oasis web: could not save the compacted session: ' + (error && error.message || error) + '\n'));
              return { ...outcome, beforeTokens: before, afterTokens: estimateTokens(target.messages) };
            }
          });
        }
        if (taskWorktree) {
          for (const [sessionKey, activeSession] of activeSessions) if (activeSession === session) activeSessions.delete(sessionKey);
          try { await closeSession(session); } catch {}
        }
        busyWorkspaces.delete(taskWorkspaceKey);
      }
    })();
    return { jobId: job.id, sessionId: activeId, ...(taskWorktree ? { isolation: 'worktree', branch: taskWorktree.branch, worktreePath: taskWorktree.relative } : {}) };
    } catch (error) {
      if (sessionId) startingSessions.delete(sessionId);
      startingWorkspaces.delete(workspaceKey);
      if (taskWorktree && !worktreeFinalized) await removeWorktree(workspaceKey, taskWorktree, { env, deleteBranch: true }).catch(() => {});
      if (releaseJobReservation) releaseJobReservation();
      throw error;
    }
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

  async function startGithubCloneJob(input) {
    const repository = String(input.repository || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) {
      throw Object.assign(new Error('Choose a repository in owner/name format from the GitHub list.'), { statusCode: 400 });
    }
    const workspaceKey = path.resolve(activeRoot);
    if (workspaceIsBusy(workspaceKey)) throw busyWorkspaceError(workspaceKey, 'switching folders');
    startingWorkspaces.add(workspaceKey);
    try {
    const status = await getGithubStatus();
    if (!status.cliAvailable || !status.authenticated) throw Object.assign(new Error(status.hint), { statusCode: 412 });
    if ([...jobs.values()].some((job) => job.status === 'running' || job.status === 'waiting_approval') || busySessions.size) {
      throw Object.assign(new Error('Wait until the current agent or terminal task finishes before switching workspaces.'), { statusCode: 409 });
    }

    const [owner, name] = repository.split('/');
    const relative = '.oasis/workspaces/' + owner + '--' + name;
    const resolved = await resolveWorkspacePath(root, relative, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true });
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

    const releaseJobReservation = reserveJobSlot();
    const job = newJob();
    job.type = 'github-clone';
    job.title = 'Clone ' + repository;
    job.workspaceRoot = workspaceKey;
    job.workspaceName = path.basename(workspaceKey);
    jobs.set(job.id, job);
    startingWorkspaces.delete(workspaceKey);
    busyWorkspaces.add(workspaceKey);
    releaseJobReservation();
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
        const staging = await resolveWorkspacePath(root, stagingRelative, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true });
        const result = await executeTool('run_command', {
          command: 'gh',
          args: ['repo', 'clone', repository, staging.absolute],
          timeoutSeconds: 600
        }, { root, env, autoApprove: true, maxCommandSeconds: 600 });
        const output = [result.stdout || '', result.stderr ? '\n' + result.stderr : '', result.error ? '\n' + result.error : ''].join('').slice(-12000);
        const cleanStaging = async () => {
          try {
            const safeStaging = await resolveWorkspacePath(root, stagingRelative, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true });
            await rm(safeStaging.absolute, { recursive: true, force: true });
          } catch { /* Never follow or remove an unsafe/symlinked path during cleanup. */ }
        };
        if (result.exitCode === 0 && !result.error) {
          try {
            const safeTarget = await resolveWorkspacePath(root, relative, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true });
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
      } finally {
        busyWorkspaces.delete(workspaceKey);
      }
    })();
    return { jobId: job.id, jobType: 'github-clone' };
    } finally {
      startingWorkspaces.delete(workspaceKey);
    }
  }

  // The user's own shell for the app's Terminal tab. run_command refuses shell executables
  // because the agent could hide anything behind them; here a person types every keystroke,
  // the agent never sees the session, and only the server's configured shell can be started.
  async function startCompanionTerminal(job, sandbox, input) {
    const shellPath = companionShell();
    const ok = await approvalFor(job, 'Open an interactive terminal in the workspace?\n  ' + shellPath + '  (in ' + activeRoot + ')\nYou type into it directly; the agent cannot see or use it. Oasis strips common secret environment variables from it.' +
      (sandbox && sandbox.available ? '\nIt will run inside the OS sandbox (' + sandbox.kind + ').' : ''), true);
    if (!ok) return { approved: false, command: shellPath, args: [], message: 'Terminal was not opened.' };
    const { launchCommand } = await import('./sandbox.mjs');
    const { scrubEnvironment } = await import('./tools.mjs');
    const launch = await launchCommand(shellPath, [], sandbox, activeRoot, { tty: true });
    try {
      return await ptyManager.start(launch.command, launch.args, {
        cwd: activeRoot, env: { ...scrubEnvironment(env), TERM: 'xterm-256color', COLORTERM: 'truecolor' }, release: launch.release,
        cols: Number.isInteger(input.cols) ? input.cols : undefined, rows: Number.isInteger(input.rows) ? input.rows : undefined,
        display: shellPath.split(/[\\/]/).pop(), sandboxed: sandbox && sandbox.available ? sandbox.kind : null
      });
    } catch (error) {
      if (typeof launch.release === 'function') launch.release();
      throw error;
    }
  }

  function companionShell() {
    return process.platform === 'win32' ? 'powershell.exe' : (/^\/[\w./+-]+$/.test(String(env.SHELL || '')) ? env.SHELL : '/bin/sh');
  }

  async function startTerminalJob(input) {
    const shell = input.shell === true;
    if (input.shell !== undefined && typeof input.shell !== 'boolean') {
      throw Object.assign(new Error('shell must be a boolean.'), { statusCode: 400 });
    }
    const command = String(input.command || '').trim();
    const commandLimit = shell ? 8000 : 200;
    if (!command || command.length > commandLimit || command.includes('\0')) {
      throw Object.assign(new Error(shell ? 'Shell command must be 8,000 characters or fewer.' : 'Enter one executable name or path (200 characters maximum).'), { statusCode: 400 });
    }
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\0'))) {
      throw Object.assign(new Error('Arguments must be an array of up to 80 strings; each argument is limited to 5,000 characters.'), { statusCode: 400 });
    }
    if (shell && args.length) throw Object.assign(new Error('Shell commands must be sent as one command string, without an argument array.'), { statusCode: 400 });
    const interactive = input.interactive === true;
    if (shell && interactive) throw Object.assign(new Error('Shell syntax is not available for interactive terminal sessions.'), { statusCode: 400 });
    const timeoutSeconds = input.timeoutSeconds === undefined ? 120 : Number(input.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 600) {
      throw Object.assign(new Error('timeoutSeconds must be an integer between 5 and 600.'), { statusCode: 400 });
    }
    const terminalSettings = await loadSettings(activeRoot, { env });
    const terminalSandbox = resolveSandbox(terminalSettings, activeRoot);
    // The agent has run_shell by default; this box takes shell syntax only when
    // the user turned shell on themselves (or a sandbox is available).
    const shellEnabled = Boolean(terminalSettings.shell && terminalSettings.shell.enabled && terminalSettings.shell.explicit) ||
      Boolean(terminalSandbox.enabled && terminalSandbox.available);
    if (shell && !shellEnabled) {
      throw Object.assign(new Error('Shell syntax is disabled. Enable shell access in your OASIS user settings, or configure an available OS sandbox. Single executables can still run without shell syntax.'), { statusCode: 403 });
    }
    const workspaceKey = path.resolve(activeRoot);
    // A companion terminal (the app's Terminal tab) runs beside the agent like an editor's
    // integrated terminal: it neither waits for nor blocks the workspace's agent tasks.
    const companion = interactive && input.companion === true;
    if (!companion && workspaceIsBusy(workspaceKey)) throw busyWorkspaceError(workspaceKey, 'running another command');
    const releaseJobReservation = reserveJobSlot();
    const job = newJob();
    job.type = interactive ? 'terminal-pty' : 'terminal';
    job.title = command + (args.length ? ' ' + args.join(' ') : '');
    job.workspaceRoot = workspaceKey;
    job.workspaceName = path.basename(workspaceKey);
    jobs.set(job.id, job);
    if (!companion) busyWorkspaces.add(workspaceKey);
    releaseJobReservation();
    emit(job, 'terminal_started', { command, args, interactive, shell, ...(companion ? { companion: true } : {}) });
    let holdWorkspaceForPty = false;
    void (async () => {
      try {
        const toolName = shell ? 'run_shell' : 'run_command';
        const toolArgs = shell ? { command, timeoutSeconds } : { command, args, timeoutSeconds, ...(interactive ? { interactive: true } : {}) };
        const result = companion ? await startCompanionTerminal(job, terminalSandbox, input) : await executeTool(toolName, toolArgs, {
          root: activeRoot,
          env,
          autoApprove: false,
          maxCommandSeconds: timeoutSeconds,
          sandbox: terminalSandbox,
          approval: (prompt) => approvalFor(job, prompt),
          signal: job.controller.signal,
          ...(interactive ? { session: ptySession } : {})
        });
        job.result = { ...result, jobType: interactive ? 'terminal-pty' : 'terminal', ...(shell ? { shell: true } : {}) };
        if (interactive && result && result.id && result.state) {
          if (!companion) {
            ptyWorkspaceLocks.set(result.id, workspaceKey);
            holdWorkspaceForPty = true;
          }
          emit(job, 'terminal_pty_started', result);
          job.status = 'completed';
          emit(job, 'completed', job.result);
          return;
        }
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
      } finally {
        if (!holdWorkspaceForPty && !companion) busyWorkspaces.delete(workspaceKey);
      }
    })();
    return { jobId: job.id, jobType: 'terminal' };
  }

  // The universal app (app/) served from this runtime: same files as
  // `oasis app`, but here it drives this computer's agent through the API.
  const resolveApp = createAppResolver(assetRoot);
  let appSkillsIndex = null;
  async function serveApp(req, res, pathname) {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache', 'x-frame-options': 'SAMEORIGIN' };
    try {
      const target = await resolveApp(pathname);
      if (!target) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (target.redirect) { res.writeHead(302, { ...headers, location: target.redirect }); res.end(); return; }
      if (target.index) {
        appSkillsIndex = appSkillsIndex || JSON.stringify(await skillsIndex(assetRoot));
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : appSkillsIndex);
        return;
      }
      if (!target.file) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const info = await lstat(target.file);
      if (!info.isFile()) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      let body = await readFile(target.file);
      if (target.file.endsWith(path.sep + 'sw.js')) body = Buffer.from(body.toString('utf8').replace('__BUILD__', 'runtime-' + Date.now().toString(36)));
      const ext = path.extname(target.file);
      const type = APP_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { ...headers, 'content-type': type, ...(ext === '.html' ? { 'content-security-policy': path.basename(target.file) === 'sandbox.html' ? SANDBOX_CONTENT_SECURITY_POLICY : appContentSecurityPolicy(body), 'permissions-policy': 'microphone=(self), camera=(), geolocation=(), usb=(), serial=(), hid=(), payment=()' } : {}) });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  async function handle(req, res) {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;

    // Sandboxed preview pages send `Origin: null`, so only the Host header is checked here;
    // the preview key in the path is what grants access.
    if ((pathname.startsWith('/preview/') || req.headers.referer) && hostAllowed({ headers: { ...req.headers, origin: undefined }, socket: req.socket, connection: req.connection }, { allowedHosts, trustProxy }) && await preview.handle(req, res, parsedUrl)) return;

    if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
      const [file, contentType] = STATIC_FILES.get(pathname);
      let body;
      let usingFallback = false;
      try {
        body = await readFile(path.join(assetRoot, file));
      } catch (error) {
        const fallback = OPTIONAL_TERMINAL_ASSETS.get(pathname);
        if (!error || error.code !== 'ENOENT' || fallback === undefined) throw error;
        body = Buffer.from(fallback);
        usingFallback = true;
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': body.length,
        'cache-control': usingFallback ? 'no-store' : file === 'sw.js' ? 'no-cache' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        // The page may use the microphone (dictation) and nothing else of this kind.
        'permissions-policy': 'microphone=(self), camera=(), geolocation=(), usb=(), serial=(), hid=(), payment=()',
        ...(contentType.startsWith('text/html') ? { 'content-security-policy': pageContentSecurityPolicy(body) } : {})
      });
      res.end(body);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || RETIRED_PAGES.has(pathname))) {
      res.writeHead(302, { location: '/app/' + (parsedUrl.search || ''), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end();
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/app' || pathname.startsWith('/app/') || pathname.startsWith('/src/') || pathname.startsWith('/vendor/'))) {
      await serveApp(req, res, pathname);
      return;
    }

    // Webhook-triggered routines authenticate with the routine's HMAC secret, not the access key.
    const hook = /^\/hooks\/routines\/(rt-[a-f0-9]{8})$/.exec(pathname);
    if (hook && req.method === 'POST') {
      if (!hostAllowed(req, { allowedHosts, trustProxy })) { json(res, 421, { error: 'Unknown host.' }); return; }
      const caller = clientAddress(req, { trustProxy });
      const waitSeconds = authLimiter.blocked(caller);
      if (waitSeconds) { res.setHeader('retry-after', String(waitSeconds)); json(res, 429, { error: 'Too many bad signatures. Try again in ' + waitSeconds + ' seconds.' }); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) { json(res, 413, { error: 'Webhook body is too large.' }); return; } chunks.push(chunk); }
      const { receiveWebhook } = await import('./routines.mjs');
      try {
        const signature = req.headers['x-hub-signature-256'] || req.headers['x-oasis-signature'] || '';
        const event = req.headers['x-github-event'] || req.headers['x-oasis-event'] || '';
        const { queued, ignored } = await receiveWebhook(hook[1], Buffer.concat(chunks), { signature: String(signature), event: String(event), env });
        authLimiter.succeed(caller);
        if (ignored) json(res, 200, { accepted: false, ignored });
        else json(res, 202, { accepted: true, event: queued });
      } catch (error) {
        if (error.statusCode === 401) authLimiter.fail(caller);
        json(res, error.statusCode || 500, { error: String(error.message || error).slice(0, 300) });
      }
      return;
    }

    // Cursor Cloud Agents API–compatible endpoints: same host checks, lockout and access key.
    if (/^\/v[01]\//.test(pathname)) {
      if (!hostAllowed(req, { allowedHosts, trustProxy })) { cursorError(res, 421, 'unauthorized', 'OASIS accepts requests only on localhost, a literal IP address or a configured --public-url host.'); return; }
      const apiCaller = clientAddress(req, { trustProxy });
      const apiWait = authLimiter.blocked(apiCaller);
      if (apiWait) { res.setHeader('retry-after', String(apiWait)); cursorError(res, 429, 'rate_limited', 'Too many wrong access keys. Try again in ' + apiWait + ' seconds.'); return; }
      if (!hasValidToken(req, token, { allowBasic: true })) {
        if (req.headers.authorization) authLimiter.fail(apiCaller);
        res.setHeader('www-authenticate', 'Basic realm="oasis"');
        cursorError(res, 401, 'unauthorized', 'Use the OASIS web access key as a Bearer token, or as the Basic auth username with an empty password.');
        return;
      }
      authLimiter.succeed(apiCaller);
      await cursorApi.handle(req, res, parsedUrl);
      return;
    }

    if (!pathname.startsWith('/api/')) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    if (!hostAllowed(req, { allowedHosts, trustProxy })) {
      json(res, 421, { error: 'Oasis API accepts requests only on localhost, a literal IP address or a configured --public-url host, with same-origin browser requests.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE' });
      res.end();
      return;
    }
    const caller = clientAddress(req, { trustProxy });
    const waitSeconds = authLimiter.blocked(caller);
    if (waitSeconds) {
      res.setHeader('retry-after', String(waitSeconds));
      json(res, 429, { error: 'Too many wrong access keys. Try again in ' + waitSeconds + ' seconds.' });
      return;
    }
    if (!hasValidToken(req, token)) {
      if (req.headers.authorization) authLimiter.fail(caller);
      json(res, 401, { error: req.headers.authorization ? 'This OASIS key is out of date: the server restarted or the key changed. Open the link OASIS printed in the terminal again.' : 'Sign in with the link OASIS printed in the terminal (it ends in #token=…).' });
      return;
    }
    authLimiter.succeed(caller);

    if (pathname === '/api/connectors' && (req.method === 'GET' || req.method === 'POST')) {
      const connectors = await import('./connectors.mjs');
      if (req.method === 'GET') { json(res, 200, { connectors: await connectors.listConnectors({ root, env }) }); return; }
      const body = await readJsonBody(req);
      if (body.action === 'disconnect') {
        try { json(res, 200, await connectors.disconnectConnector(String(body.service || '').slice(0, 300), { root, env })); }
        catch (error) { json(res, 404, { error: String(error.message || error).slice(0, 800) }); }
        return;
      }
      let connector;
      try { connector = await connectors.resolveConnector(String(body.service || '').slice(0, 300), { env }); }
      catch (error) { json(res, 404, { error: String(error.message || error).slice(0, 800) }); return; }
      const flow = connectors.createConnectFlow(connector, { root, env, reason: String(body.reason || '') });
      keepFlow(flow);
      json(res, 200, flow.view());
      return;
    }
    const connectorMatch = pathname.match(/^\/api\/connectors\/([a-f0-9-]{36})$/i);
    if (connectorMatch && (req.method === 'GET' || req.method === 'POST')) {
      const flow = connectFlows.get(connectorMatch[1]);
      if (!flow) { json(res, 404, { error: 'That connector card has expired. Ask again to get a new one.' }); return; }
      if (req.method === 'GET') { json(res, 200, flow.view()); return; }
      const body = await readJsonBody(req);
      try {
        const action = String(body.action || '');
        const view = action === 'connect' ? flow.connect()
          : action === 'skip' ? flow.skip()
          : action === 'token' ? flow.submitToken(String(body.token || '').slice(0, 300))
          : action === 'callback' ? flow.pasteCallback(String(body.address || '').slice(0, 4000))
          : null;
        if (!view) { json(res, 400, { error: 'action must be connect, skip, token or callback.' }); return; }
        json(res, 200, view);
      } catch (error) { json(res, 400, { error: String(error.message || error).slice(0, 500) }); }
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

    // Routines (`oasis schedule`), for the signed-in owner of this server.
    if (pathname === '/api/routines' && (req.method === 'GET' || req.method === 'POST')) {
      const routines = await import('./routines.mjs');
      const view = (job) => ({ id: job.id, name: job.name || '', kind: job.kind, prompt: job.prompt, schedule: job.schedule.display, timezone: job.timezone || '', enabled: job.enabled !== false, state: job.activeRun ? 'running' : job.enabled === false ? job.state || 'paused' : 'scheduled', nextRunAt: job.enabled !== false ? job.nextRunAt || null : null, lastStatus: job.lastStatus || '', lastRunAt: job.lastRunAt || null, deliver: job.deliver || 'local', workdir: job.workdir || '', pausedReason: job.pausedReason || '', lastProblem: job.lastProblem || '', updatedAt: job.updatedAt || null, ...(job.schedule.type === 'event' ? { webhookPath: '/hooks/routines/' + job.id, webhookSecret: job.webhookSecret, pendingEvents: (job.pendingEvents || []).length } : {}) });
      const overview = async () => ({ routines: (await routines.readJobs(env)).map(view), scheduler: (await routines.schedulerRunning(env)) ? 'running' : 'stopped' });
      if (req.method === 'GET' && parsedUrl.searchParams.get('runs')) {
        try {
          const { job, runs } = await routines.listRuns(parsedUrl.searchParams.get('runs'), { env, limit: 10 });
          const outDir = path.join(routines.schedulesDirectory(env), 'output', job.id);
          const withOutput = await Promise.all(runs.reverse().map(async (run) => {
            let output = '';
            // Only files the scheduler wrote for this routine.
            if (run.outputFile && path.dirname(path.resolve(run.outputFile)) === outDir) { try { output = (await readFile(run.outputFile, 'utf8')).slice(0, 4000); } catch {} }
            return { status: run.status, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null, manual: Boolean(run.manual), event: run.eventId || null, reason: run.reason || '', delivery: run.delivery || '', deliveryError: run.deliveryError || '', backgroundId: run.backgroundId || '', output };
          }));
          json(res, 200, { id: job.id, runs: withOutput });
        } catch (error) { json(res, 404, { error: String(error.message || error).slice(0, 500) }); }
        return;
      }
      if (req.method === 'GET') { json(res, 200, await overview()); return; }
      const body = await readJsonBody(req);
      const action = String(body.action || '');
      const id = String(body.id || '');
      try {
        if (action === 'create') {
          const f = body.fields && typeof body.fields === 'object' ? body.fields : {};
          await routines.createJob({ schedule: String(f.schedule || ''), prompt: String(f.prompt || ''), name: f.name ? String(f.name) : undefined, kind: f.kind === 'script' ? 'script' : 'agent', timezone: f.timezone ? String(f.timezone) : undefined, deliver: f.deliver ? String(f.deliver) : undefined, workdir: f.workdir ? String(f.workdir) : activeRoot, paused: Boolean(f.paused) }, { env });
        } else if (action === 'edit') {
          const f = body.fields && typeof body.fields === 'object' ? body.fields : {};
          const allowed = {};
          for (const key of ['schedule', 'prompt', 'name', 'timezone', 'deliver', 'events']) if (f[key] !== undefined) allowed[key] = key === 'events' ? f[key] : String(f[key]);
          await routines.editJob(id, allowed, { env, expectedUpdatedAt: body.expectedUpdatedAt === undefined ? undefined : body.expectedUpdatedAt });
        } else if (action === 'pause') await routines.pauseJob(id, 'Paused from the browser.', { env });
        else if (action === 'resume') await routines.resumeJob(id, { env });
        else if (action === 'run') await routines.triggerJob(id, { env });
        else if (action === 'cancel') await routines.cancelRun(id, { env });
        else if (action === 'prune') await routines.removeFinished({ env });
        else if (action === 'remove') { const { stopBackgroundSession } = await import('./background-sessions.mjs'); await routines.removeJob(id, { env, stop: stopBackgroundSession }); }
        else { json(res, 400, { error: 'Unknown routine action.' }); return; }
      } catch (error) { json(res, error && error.statusCode === 409 ? 409 : 400, { error: String(error && error.message || error).slice(0, 2000) }); return; }
      json(res, 200, await overview());
      return;
    }

    // Claude Code plugins and marketplaces, as `oasis plugin` manages them.
    if (req.method === 'GET' && pathname === '/api/plugins') {
      const { pluginOverview } = await import('./claude-plugins.mjs');
      json(res, 200, await pluginOverview(activeRoot, { env }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/plugins') {
      const body = await readJsonBody(req);
      const action = String(body.action || '');
      const target = String(body.target || '').trim();
      if (!target || target.length > 400) {
        json(res, 400, { error: 'Name the plugin (NAME@MARKETPLACE) or marketplace (OWNER/REPO).' });
        return;
      }
      const plugins = await import('./claude-plugins.mjs');
      try {
        let message;
        if (action === 'install') {
          const result = await plugins.installPlugin(target, { env, root: activeRoot, scope: 'user' });
          message = 'Installed ' + result.id + '. It loads in new conversations.';
        } else if (action === 'uninstall') {
          message = 'Removed ' + await plugins.uninstallPlugin(target, { env }) + '.';
        } else if (action === 'enable' || action === 'disable') {
          const result = await plugins.setPluginEnabled(target, action === 'enable', { env, root: activeRoot, scope: 'user' });
          message = (action === 'enable' ? 'Turned on ' : 'Turned off ') + result.id + '. This applies to new conversations.';
        } else if (action === 'add-marketplace') {
          const added = await plugins.addMarketplace(target, { env, cwd: activeRoot });
          message = 'Added ' + added.name + ' with ' + added.plugins.length + ' plugins.';
        } else if (action === 'remove-marketplace') {
          await plugins.removeMarketplace(target, { env });
          message = 'Removed the ' + target + ' marketplace. Installed plugins stay until you remove them.';
        } else {
          json(res, 400, { error: 'Unknown action. Use install, uninstall, enable, disable, add-marketplace or remove-marketplace.' });
          return;
        }
        json(res, 200, { ok: true, message, ...(await plugins.pluginOverview(activeRoot, { env })) });
      } catch (error) {
        json(res, 400, { error: String(error && error.message || error).slice(0, 2000) });
      }
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

    // Claude Code's fileSuggestion for the web composer's "@": the same command the terminal runs,
    // with the same trust and hook gates. { paths: null } means "use the built-in file list".
    if (req.method === 'GET' && pathname === '/api/file-suggestions') {
      const query = String(parsedUrl.searchParams.get('q') || '').slice(0, 200);
      const settings = await loadSettings(activeRoot, { env }).catch(() => null);
      const setting = settings && settings.fileSuggestion;
      if (!setting) { json(res, 200, { paths: null }); return; }
      const { suggestFilesWithCommand } = await import('./completion.mjs');
      json(res, 200, { paths: await suggestFilesWithCommand(setting, query, { root: activeRoot, env }) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/slash-commands') {
      json(res, 200, { commands: await webSlashCommands(activeRoot, env) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      let provider = null;
      let providerConfigured = false;
      let fallbacks = [];
      let setupHint = '';
      try {
        const config = await getConfig();
        provider = { ...getProviderSummary(config), baseURL: config.baseURL };
        providerConfigured = Boolean(config.configured);
        fallbacks = String(config.fallbackModel || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 6);
        if (!providerConfigured) setupHint = 'No model API key is configured for the selected provider. Run oasis setup in the terminal, or configure OASIS_API_KEY in the runtime environment.';
      } catch (error) {
        providerConfigured = false;
        setupHint = error.message || 'Run oasis setup in the terminal.';
      }
      const branch = await import('./git-tools.mjs').then((mod) => mod.workspaceBranch(activeRoot, env)).catch(() => null);
      // An empty folder gets new-project suggestions on the welcome screen.
      const workspaceEmpty = await import('./agent.mjs').then((mod) => mod.workspaceIsEmpty(activeRoot)).catch(() => false);
      json(res, 200, {
        connected: true,
        workspaceEmpty,
        providerConfigured,
        provider: provider ? { provider: provider.provider, protocol: provider.protocol, model: provider.model, baseURL: provider.baseURL, authentication: provider.authentication } : null,
        fallbacks,
        providerSetupAvailable: canManage(req),
        workspaceName: path.basename(activeRoot),
        workspacePath: activeRoot,
        branch: branch ? String(branch).slice(0, 200) : null,
        workspaceAccess: 'local-filesystem',
        approvalMode: 'per-action',
        // The shell the browser Terminal tab starts; the server may run on another OS than the browser.
        terminalShell: companionShell(),
        setupHint
      });
      return;
    }

    if (pathname === '/api/app/update') {
      // Reports a new release and the command that installs it (oasis update).
      const statePath = path.join(getBaseConfigDirectory(env), 'update-state.json');
      if (req.method === 'GET') {
        try {
          // ?refresh=1 is a manual "Check now": skip the 6-hour cache.
          const force = parsedUrl.searchParams.get('refresh') === '1';
          // The desktop app answers from its own updater, which can install.
          const bridge = options.appUpdate;
          if (bridge) {
            json(res, 200, { host: 'desktop', ...(force || !bridge.status().checkedAt ? await bridge.check() : bridge.status()) });
            return;
          }
          if (updateChecksDisabled(env)) { json(res, 200, { host: 'cli', phase: 'disabled', available: false, current: oasisVersion() }); return; }
          const result = await cachedUpdateCheck({ statePath, currentVersion: oasisVersion(), kind: 'cli', fetchImpl: options.updateFetchImpl || fetch, force });
          json(res, 200, {
            host: 'cli', phase: result.available ? 'available' : 'current', available: result.available,
            current: result.current, latest: result.latest, skippedVersion: result.skippedVersion,
            checkedAt: result.checkedAt, canInstall: false, command: 'oasis update',
            releasesPage: result.latest ? result.latest.url : RELEASES_PAGE
          });
        } catch (error) {
          json(res, 200, { host: options.appUpdate ? 'desktop' : 'cli', phase: 'error', available: false, current: oasisVersion(), error: String(error && error.message || error) });
        }
        return;
      }
      if (req.method === 'POST') {
        if (!canManage(req)) { json(res, 403, { error: 'Updates can be managed only from the same computer or over HTTPS.' }); return; }
        const body = await readJsonBody(req);
        const action = String(body && body.action || '');
        const version = typeof (body && body.version) === 'string' ? body.version.slice(0, 40) : '';
        const bridge = options.appUpdate;
        if (action === 'skip') {
          if (bridge) { json(res, 200, { host: 'desktop', ...(await bridge.skip(version || undefined)) }); return; }
          const state = await readUpdateState(statePath);
          await writeUpdateState(statePath, { ...state, skippedVersion: version || (state.lastResult && state.lastResult.latest && state.lastResult.latest.version) || '' });
          json(res, 200, { host: 'cli', skipped: true });
          return;
        }
        if (action === 'install') {
          if (!bridge) { json(res, 400, { error: 'Run oasis update in a terminal to install the new version.' }); return; }
          // Respond first: installing can quit the app that serves this request.
          // The desktop host still asks with a native dialog before installing.
          json(res, 202, { host: 'desktop', accepted: true });
          setImmediate(() => { void Promise.resolve(bridge.prompt()).catch(() => {}); });
          return;
        }
        json(res, 400, { error: 'Unknown update action.' });
        return;
      }
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/system/profile') {
      // Hardware and local model servers of the computer running OASIS. Like
      // local-model discovery it probes only fixed loopback ports, and it is not
      // shown to second devices on the network.
      if (!canManage(req)) { json(res, 403, { error: 'Hardware detection is available only from the same computer or over HTTPS.' }); return; }
      try {
        const { profileThisComputer, describeHardware } = await import('./hardware.mjs');
        let configured = false;
        try { configured = Boolean((await getConfig()).configured); } catch {}
        const rec = await (options.profileComputer || profileThisComputer)({ configured, fetchImpl: options.fetchImpl || fetch });
        json(res, 200, { ...rec, summary: describeHardware(rec.hardware) });
      } catch (error) {
        json(res, 500, { error: 'Could not inspect this computer: ' + (error && error.message || error) });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/provider/local-models') {
      // This status check never accepts a caller-supplied URL: it can only query
      // the conventional local Ollama endpoint on this computer.
      if (!canManage(req)) {
        json(res, 403, { error: 'Local model discovery is available only from the same computer or over HTTPS.' });
        return;
      }
      try {
        const response = await (options.fetchImpl || fetch)('http://127.0.0.1:11434/api/tags', {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(1500),
          headers: { accept: 'application/json' }
        });
        if (!response.ok) throw new Error('Ollama did not respond successfully.');
        const payload = await response.json();
        const models = Array.isArray(payload && payload.models)
          ? payload.models.map((model) => String(model && (model.name || model.model) || '').trim()).filter(Boolean).slice(0, 100)
          : [];
        json(res, 200, {
          available: true,
          models,
          message: models.length
            ? 'Ollama is running. Choose an installed model, then test the connection.'
            : 'Ollama is running, but no models are installed yet. Install a model from the Ollama app or terminal, then check again.'
        });
      } catch {
        json(res, 200, {
          available: false,
          models: [],
          message: 'Ollama was not found or is not running. Install it from ollama.com/download, open it, and check again.'
        });
      }
      return;
    }

    if (req.method === 'POST' && (pathname === '/api/provider/connect' || pathname === '/api/provider/model')) {
      // Paste-to-connect and model switching. Keys are accepted only over a direct
      // local connection or HTTPS, are stored on this computer, and never echoed back.
      if (!canManage(req)) {
        json(res, 403, { error: 'Connect a model from the computer running OASIS, or open OASIS over HTTPS. Keys are never accepted over plain HTTP from another device.' });
        return;
      }
      const body = await readJsonBody(req);
      let next;
      let reply = {};
      try {
        if (pathname === '/api/provider/model') {
          const current = await getConfig();
          const model = String(body.model || '').trim();
          if (!model || model.length > 200) throw Object.assign(new Error('Choose a model.'), { statusCode: 400 });
          const chain = String(current.fallbackModel || '').split(',').map((id) => id.trim()).filter(Boolean);
          next = { protocol: current.protocol, baseURL: current.baseURL, model, apiKey: current.apiKey || '', fallbackModel: [current.model, ...chain].filter((id) => id && id !== model).slice(0, 3).join(',') };
          reply = { label: new URL(current.baseURL).host };
        } else {
          const text = String(body.text || '').trim();
          if (!text || text.length > 8000) throw Object.assign(new Error('Paste an API key, a model page link or a local server address.'), { statusCode: 400 });
          const steps = [];
          const result = await connectFromPaste(text, { onStatus: (status) => { steps.push(status); } });
          next = result.config;
          reply = { label: result.label, provider: result.provider, models: result.models, toolCalling: result.toolCalling, notes: result.notes, masked: result.masked, steps: steps.slice(-12) };
        }
        // The desktop app stores the key in the OS key store (Electron
        // safeStorage) and only the non-secret details in the config file.
        if (typeof options.onProviderConfig === 'function') await options.onProviderConfig(next);
        else await saveConfig(next, { env });
      } catch (error) {
        const raw = String(error && error.message || 'Could not connect.');
        const key = next && next.apiKey;
        json(res, error && error.statusCode || 422, { saved: false, error: (key ? raw.split(key).join('[redacted]') : raw).slice(0, 1600) });
        return;
      }
      json(res, 200, { saved: true, ...reply, provider: { protocol: next.protocol, baseURL: next.baseURL, model: next.model, provider: reply.provider || '' }, fallbacks: next.fallbackModel ? next.fallbackModel.split(',') : [] });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/provider/config') {
      // Provider credentials are accepted only over a direct local connection or HTTPS.
      if (!canManage(req)) {
        json(res, 403, { error: 'Provider setup is available from the same computer, or from another device over HTTPS. Model API keys are never accepted over plain HTTP.' });
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
      try {
        await testProviderConnection({ protocol, baseURL, model, apiKey }, { timeoutMs: 30000 });
      } catch (error) {
        const rawMessage = String(error && error.message || 'Provider verification failed.');
        const safeMessage = apiKey ? rawMessage.split(apiKey).join('[redacted]') : rawMessage;
        json(res, 422, { saved: false, verified: false, error: safeMessage.slice(0, 1600) });
        return;
      }
      // The desktop host commits the encrypted key and the non-secret details
      // together. Otherwise the key goes to the local config file with
      // owner-only permissions (0600) where the OS supports it. It is never
      // sent back to the page.
      if (typeof options.onProviderConfig === 'function') await options.onProviderConfig({ protocol, baseURL, model, apiKey });
      else await saveConfig({ protocol, baseURL, model, apiKey }, { env });
      json(res, 200, {
        saved: true,
        verified: true,
        provider: { protocol, provider: new URL(baseURL).host, model, authentication: apiKey ? 'API key configured' : (isLoopbackUrl(baseURL) ? 'local endpoint; no API key required' : 'not configured') },
        note: 'The provider returned a valid tool-call response. The inert probe was not executed; settings were saved locally and the API key is never returned.'
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/github/clone') {
      const body = await readJsonBody(req);
      const result = await startGithubCloneJob(body);
      json(res, 202, result);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/file') {
      const requestedPath = parsedUrl.searchParams.get('path') || '';
      if (!requestedPath || requestedPath.length > 1000) {
        json(res, 400, { error: 'Choose a workspace file to preview.' });
        return;
      }
      let previewRoot = activeRoot;
      const previewJobId = parsedUrl.searchParams.get('jobId') || '';
      if (previewJobId) {
        if (!/^[a-f0-9-]{20,80}$/i.test(previewJobId)) {
          json(res, 400, { error: 'The preview task identifier is invalid.' });
          return;
        }
        const previewJob = jobs.get(previewJobId);
        if (!previewJob || previewJob.type !== 'agent' || !previewJob.executionRoot) {
          json(res, 404, { error: 'The task workspace is no longer available for preview.' });
          return;
        }
        previewRoot = previewJob.executionRoot;
      }
      try {
        const target = await resolveWorkspacePath(previewRoot, requestedPath, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true });
        const info = await lstat(target.absolute);
        if (!info.isFile() || info.isSymbolicLink()) {
          json(res, 400, { error: 'Only regular text files can be previewed here.' });
          return;
        }
        if (info.size > MAX_FILE_PREVIEW_BYTES) {
          json(res, 413, { error: 'This file is too large for an inline preview (256 KiB limit). Use the project editor or Changes panel to inspect it.' });
          return;
        }
        // Read through a handle opened without following a final symlink, and
        // re-check it, so a file swapped for a symlink or FIFO after the lstat
        // above cannot be read or hang the request.
        const buffer = await readRegularFileNoFollow(target.absolute, MAX_FILE_PREVIEW_BYTES);
        if (!buffer) {
          json(res, 400, { error: 'Only regular text files can be previewed here.' });
          return;
        }
        if (buffer.includes(0)) {
          json(res, 415, { error: 'This file appears to be binary and cannot be shown as text.' });
          return;
        }
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { json(res, 415, { error: 'This file is not valid UTF-8 text and cannot be previewed.' }); return; }
        json(res, 200, {
          path: target.relative.split(path.sep).join('/'),
          content,
          bytes: buffer.length,
          lineCount: content.length ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0,
          modifiedAt: info.mtime.toISOString()
        });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          json(res, 404, { error: 'No file named ' + requestedPath.slice(0, 200) + ' in this workspace.' });
          return;
        }
        const message = String(error && error.message || error || 'Could not preview this file.');
        const status = error && error.code === 'ELOOP' ? 403 :
          (/sensitive|outside the workspace|symbolic link|resolves outside/i.test(message) ? 403 : 400);
        json(res, status, { error: status === 403 ? 'This path is protected or outside the task workspace.' : message.slice(0, 500) });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/preview') {
      let recordings = [];
      try {
        const { readdir } = await import('node:fs/promises');
        recordings = (await readdir(path.join(activeRoot, '.oasis', 'recordings'))).filter((name) => /^browser-[\w.-]+\.html$/.test(name)).sort().reverse().slice(0, 20).map((name) => '.oasis/recordings/' + name);
      } catch {}
      // Design artboards: each folder under design/ with HTML variants (see the design skill).
      const designs = [];
      try {
        const { readdir } = await import('node:fs/promises');
        const folders = (await readdir(path.join(activeRoot, 'design'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[\w.-]+$/.test(entry.name));
        for (const folder of folders.slice(0, 40)) {
          const files = (await readdir(path.join(activeRoot, 'design', folder.name))).filter((name) => /^[\w.-]+\.html?$/i.test(name)).sort().slice(0, 12);
          if (files.length) designs.push({ name: folder.name, files: files.map((name) => 'design/' + folder.name + '/' + name) });
        }
        designs.sort((a, b) => a.name.localeCompare(b.name));
      } catch {}
      json(res, 200, { base: preview.base(null), recordings, designs });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/files') {
      try {
        const result = await listWorkspaceFiles(activeRoot, { limit: 5000, isSecretPath: sensitivePath });
        json(res, 200, { workspaceName: path.basename(activeRoot), ...result });
      } catch (error) {
        json(res, 500, { error: 'Could not list workspace files: ' + String(error && error.message || error).slice(0, 300) });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/workspace/diff') {
      try {
        const result = await readWorkspaceDiff(activeRoot, { env, maxChars: 180000, isSecretPath: sensitivePath });
        json(res, 200, { workspaceName: path.basename(activeRoot), ...result });
      } catch (error) {
        json(res, 500, { error: 'Could not read workspace changes: ' + String(error && error.message || error).slice(0, 300) });
      }
      return;
    }

    // Files the person adds from the browser (Files panel upload) go into the
    // real project folder. Same boundaries as the agent's own writes: inside
    // the workspace, no symlinks, no protected paths (.env, .git, keys), no
    // overwrite unless asked, and not while an agent is working.
    if (req.method === 'POST' && pathname === '/api/workspace/upload') {
      if ([...jobs.values()].some((job) => job.status === 'running' || job.status === 'waiting_approval') || busySessions.size) {
        json(res, 409, { error: 'Wait until the current agent task finishes before adding files.' });
        return;
      }
      const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length || files.length > 200) {
        json(res, 400, { error: 'Choose between 1 and 200 files to add.' });
        return;
      }
      const overwrite = body.overwrite === true;
      const written = [];
      const existing = [];
      const refused = [];
      const planned = [];
      for (const file of files) {
        const relative = String(file && file.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const data = typeof (file && file.base64) === 'string' ? Buffer.from(file.base64, 'base64') : typeof (file && file.content) === 'string' ? Buffer.from(file.content, 'utf8') : null;
        if (!relative || relative.length > 500 || !data || data.length > MAX_UPLOAD_FILE_BYTES) { refused.push({ path: relative || '(unnamed)', reason: data && data.length > MAX_UPLOAD_FILE_BYTES ? 'larger than 10 MB' : 'invalid file' }); continue; }
        let target;
        try { target = await resolveWorkspacePath(activeRoot, relative, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true }); }
        catch { refused.push({ path: relative, reason: 'outside the project or a link' }); continue; }
        const rel = target.relative.split(path.sep).join('/');
        if (sensitivePath(rel) || /^\.git(\/|$)/.test(rel) || /^\.oasis(\/|$)/.test(rel)) { refused.push({ path: rel, reason: 'protected path' }); continue; }
        const present = await lstat(target.absolute).then((info) => info, () => null);
        if (present && (!present.isFile() || present.isSymbolicLink() || present.nlink > 1)) { refused.push({ path: rel, reason: 'not a regular file' }); continue; }
        if (present && !overwrite) { existing.push(rel); continue; }
        planned.push({ rel, absolute: target.absolute, data });
      }
      if (existing.length && !overwrite) {
        json(res, 409, { error: 'Some files already exist.', existing, refused });
        return;
      }
      for (const item of planned) {
        await mkdir(path.dirname(item.absolute), { recursive: true });
        await atomicWriteFile(item.absolute, item.data, { encoding: null });
        written.push(item.rel);
      }
      json(res, 200, { written, refused });
      return;
    }

    // "Discard changes" in the Changes panel: put one tracked file back to its
    // last-commit version. Same boundaries as uploads (inside the workspace, no
    // symlinks, not .git, not while an agent works). Untracked files are left
    // alone: there is no committed version to go back to.
    if (req.method === 'POST' && pathname === '/api/workspace/discard') {
      if ([...jobs.values()].some((job) => job.status === 'running' || job.status === 'waiting_approval') || busySessions.size || workspaceIsBusy(path.resolve(activeRoot))) {
        json(res, 409, { error: 'Wait until the current agent task finishes before discarding changes.' });
        return;
      }
      const body = await readJsonBody(req, 4096).catch(() => ({}));
      const relative = String(body && body.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.length > 500) { json(res, 400, { error: 'Choose a changed file to discard.' }); return; }
      let target;
      try { target = await resolveWorkspacePath(activeRoot, relative, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true }); }
      catch { json(res, 403, { error: 'This path is protected or outside the workspace.' }); return; }
      const rel = target.relative.split(path.sep).join('/');
      if (/^\.git(\/|$)/.test(rel)) { json(res, 403, { error: 'This path is protected or outside the workspace.' }); return; }
      const present = await lstat(target.absolute).then((info) => info, () => null);
      if (present && (!present.isFile() || present.isSymbolicLink() || present.nlink > 1)) { json(res, 400, { error: 'Only regular files can be restored here.' }); return; }
      let version;
      try { version = await headFileVersion(activeRoot, rel, { env }); }
      catch (error) { json(res, 400, { error: error.code === 'EUNSUPPORTED' ? error.message : 'Could not read the last commit.' }); return; }
      if (!version) { json(res, 404, { error: rel + ' is not in the last commit, so there is no version to go back to. Delete it from the Files tab if you do not want it.' }); return; }
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await atomicWriteFile(target.absolute, version.content, { encoding: null, mode: version.mode });
      json(res, 200, { path: rel, restored: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/workspace/reset') {
      if ([...jobs.values()].some((job) => job.status === 'running' || job.status === 'waiting_approval') || busySessions.size || workspaceIsBusy(path.resolve(activeRoot))) {
        json(res, 409, { error: 'Wait until the current agent or terminal task finishes before switching workspaces.' });
        return;
      }
      activeRoot = root;
      json(res, 200, { workspaceName: path.basename(activeRoot), workspacePath: activeRoot, reset: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      // A running conversation names its live job, so another browser (or the
      // same one after a reload) can attach to it instead of only reading history.
      const liveJobs = new Map();
      for (const job of jobs.values()) {
        if (job.type && job.type !== 'agent') continue;
        if (!['running', 'waiting_approval', 'waiting_input'].includes(job.status) || !job.sessionId) continue;
        liveJobs.set(String(job.sessionId).toLowerCase(), job);
      }
      // Archived sessions (from the App Server or `oasis sessions archive`) stay
      // out of the list unless ?archived=1 asks for them; running ones always show.
      const wantArchived = /^(1|true)$/i.test(parsedUrl.searchParams.get('archived') || '');
      const sessions = (await listSessions(activeRoot, { env })).filter((item) => Boolean(item.archived) === wantArchived || busySessions.has(String(item.id).toLowerCase())).map((item) => {
        const id = String(item.id).toLowerCase();
        if (!busySessions.has(id)) return item;
        const job = liveJobs.get(id);
        return { ...item, running: true, ...(job ? { jobId: job.id, prompt: job.prompt || job.title || '', ...(job.status === 'running' ? {} : { waiting: true }) } : {}) };
      });
      // A brand-new conversation is written to disk after its first turn; list it while it runs.
      const listed = new Set(sessions.map((item) => String(item.id).toLowerCase()));
      for (const [id, job] of liveJobs) {
        if (listed.has(id)) continue;
        sessions.unshift({ id: job.sessionId, title: job.title || 'Coding task', updatedAt: job.events.at(-1)?.at || job.createdAt, messages: 0, unsaved: true, running: true, jobId: job.id, prompt: job.prompt || job.title || '', ...(job.status === 'running' ? {} : { waiting: true }) });
      }
      json(res, 200, { sessions });
      return;
    }

    // Chats the app kept only in a browser (made without this server) are copied here when
    // the app connects, so the session store holds them and other devices can open them.
    // The key (the browser's project and chat id) maps to a fixed session id: sending the
    // same chat again updates its copy instead of adding another. Only text turns are kept.
    if (req.method === 'POST' && pathname === '/api/sessions/import') {
      let body;
      try { body = await readJsonBody(req, MAX_IMPORT_BYTES); } catch (error) { json(res, 400, { error: error.message }); return; }
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key || key.length > 200) { json(res, 400, { error: 'An imported chat needs a key of up to 200 characters.' }); return; }
      // Bounded by MAX_IMPORT_BYTES; a count cap dropped the start of long chats.
      const turns = (Array.isArray(body.messages) ? body.messages : [])
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim() && !item.content.includes('\0'))
        .map((item) => ({ role: item.role, content: item.content.slice(0, MAX_STREAMED_REPLY_CHARS) }));
      if (!turns.some((item) => item.role === 'user')) { json(res, 400, { error: 'An imported chat needs at least one message from you.' }); return; }
      const digest = createHash('sha256').update(path.resolve(activeRoot) + '\0' + key).digest('hex');
      const id = [digest.slice(0, 8), digest.slice(8, 12), '4' + digest.slice(13, 16), '8' + digest.slice(17, 20), digest.slice(20, 32)].join('-');
      const project = typeof body.project === 'string' ? body.project.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 60) : '';
      const title = typeof body.title === 'string' ? body.title.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 80) : '';
      if (busySessions.has(id)) { json(res, 409, { error: 'That chat is running here right now.' }); return; }
      try {
        const saved = await saveSession({ root: activeRoot, sessionId: id, config: { protocol: 'browser', model: typeof body.model === 'string' ? body.model.slice(0, 120) : '' }, sessionName: ((project ? project + ': ' : '') + (title || 'Browser chat')).slice(0, 120), messages: [{ role: 'system', content: 'Chat copied from the OASIS browser app.' }, ...turns], todos: [] }, { env, checkpoints: false });
        activeSessions.delete(id);
        json(res, 200, { id: saved.id, updatedAt: saved.updatedAt, messages: turns.length });
      } catch (error) { json(res, 400, { error: 'Could not save that chat: ' + (error && error.message || 'unknown error') }); }
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]{20,80})$/i);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      let saved;
      // Missing (a first turn still running, or deleted) is 404, not a server error.
      try { saved = await loadSession(activeRoot, id, { env }); }
      catch (error) { json(res, error && error.code === 'ENOENT' ? 404 : 400, { error: error && error.code === 'ENOENT' ? 'That session is not saved yet or no longer exists.' : 'Could not open that session: ' + (error && error.message || 'unknown error') }); return; }
      // System reminders (checklist, hook feedback) are for the model, not the chat view.
      const messages = saved.messages.filter((item) => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
        .map((item) => ({ role: item.role, content: (item.role === 'user' ? userFacingPrompt(item.content) : item.content.trim() ? item.content : '').slice(0, MAX_STREAMED_REPLY_CHARS) }))
        .filter((item) => item.content);
      json(res, 200, { id, updatedAt: saved.updatedAt, messages, display: savedSessionDisplay(saved.messages) });
      return;
    }

    // Standalone HTML page for a saved chat (the same page as /export FILE.html).
    const exportMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]{20,80})\/export$/i);
    if (req.method === 'GET' && exportMatch) {
      let saved;
      try { saved = await loadSession(activeRoot, exportMatch[1], { env }); }
      catch (error) { json(res, error && error.code === 'ENOENT' ? 404 : 400, { error: 'Could not export that chat: ' + (error && error.message || 'unknown error') }); return; }
      const { conversationHtml } = await import('./session-html.mjs');
      const live = activeSessions.get(String(exportMatch[1]).toLowerCase());
      const model = String(live && live.config && live.config.model || saved.provider && saved.provider.model || '');
      const html = conversationHtml({ root: activeRoot, config: { model: model || 'unknown' }, messages: saved.messages });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'attachment; filename="oasis-chat-' + exportMatch[1].slice(0, 8) + '.html"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
      res.end(html);
      return;
    }

    const archiveMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]{20,80})\/(archive|unarchive)$/i);
    if (req.method === 'POST' && archiveMatch) {
      try { json(res, 200, await setSessionArchived(activeRoot, archiveMatch[1].toLowerCase(), archiveMatch[2].toLowerCase() === 'archive', { env })); }
      catch (error) { json(res, error && error.code === 'ENOENT' ? 404 : 400, { error: 'Could not update that chat: ' + (error && error.message || 'unknown error') }); }
      return;
    }

    if (req.method === 'DELETE' && sessionMatch) {
      const id = sessionMatch[1].toLowerCase();
      if (busySessions.has(id) || startingSessions.has(id)) { json(res, 409, { error: 'That chat is still running. Stop it before deleting it.' }); return; }
      try { await deleteSession(activeRoot, id, { env }); } catch (error) { json(res, error && error.code === 'ENOENT' ? 404 : 400, { error: 'Could not delete that chat: ' + (error && error.message || 'unknown error') }); return; }
      activeSessions.delete(id);
      json(res, 200, { id, deleted: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/terminal/pty/list') {
      json(res, 200, ptyManager.list());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/terminal/pty/read') {
      try {
        const id = parsedUrl.searchParams.get('id') || '';
        const numberParam = (key, fallback) => {
          const raw = parsedUrl.searchParams.get(key);
          if (raw === null || raw === '') return fallback;
          const value = Number(raw);
          return Number.isFinite(value) ? Math.floor(value) : fallback;
        };
        const result = await ptyManager.read(id, {
          offset: numberParam('offset', 0),
          maxChars: numberParam('max_chars', 12000),
          waitMs: numberParam('wait_seconds', 0) * 1000
        });
        json(res, 200, result);
      } catch (error) {
        const message = String(error && error.message || error);
        json(res, /No terminal session exists/.test(message) ? 404 : 400, { error: message.slice(0, 2000) });
      }
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/terminal/pty/')) {
      const body = await readJsonBody(req);
      try {
        let result;
        if (pathname === '/api/terminal/pty/input') {
          if (typeof body.data !== 'string') { json(res, 400, { error: 'data must be a string.' }); return; }
          result = ptyManager.write(body.id, body.data);
        } else if (pathname === '/api/terminal/pty/resize') {
          if (!Number.isInteger(body.cols) || !Number.isInteger(body.rows)) { json(res, 400, { error: 'cols and rows must be integers.' }); return; }
          result = ptyManager.resize(body.id, body.cols, body.rows);
        } else if (pathname === '/api/terminal/pty/interrupt') result = ptyManager.interrupt(body.id);
        else if (pathname === '/api/terminal/pty/stop') result = ptyManager.stop(body.id);
        else { json(res, 404, { error: 'Unknown PTY terminal action.' }); return; }
        json(res, 200, result);
      } catch (error) {
        const message = String(error && error.message || error);
        const status = /No terminal session exists/.test(message) ? 404 : (/too large|only accepted|Only a running/.test(message) ? 400 : 409);
        json(res, status, { error: message.slice(0, 2000) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/terminal/command') {
      const body = await readJsonBody(req);
      const result = await startTerminalJob(body);
      json(res, 202, result);
      return;
    }

    // Dictation for browsers without working speech recognition (Firefox and some embedded browsers): the page
    // records with MediaRecorder and OASIS transcribes with the user's configured endpoint.
    if (req.method === 'POST' && pathname === '/api/transcribe') {
      const voice = await import('./voice.mjs');
      const settings = await loadSettings(root, { env }).catch(() => ({}));
      if (settings && settings.voiceDisabledByPolicy) { json(res, 403, { error: 'Voice dictation is turned off by managed settings.' }); return; }
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!voice.AUDIO_TYPES.has(type)) { json(res, 415, { error: 'Send audio (webm, ogg, mp4, mpeg or wav).' }); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_TRANSCRIBE_BYTES) { json(res, 413, { error: 'The recording is too long.' }); return; }
        chunks.push(chunk);
      }
      try {
        const text = await voice.transcribeAudio(Buffer.concat(chunks), { settings, env, mediaType: type, hints: [path.basename(root)] });
        json(res, 200, { text });
      } catch (error) {
        json(res, 502, { error: String(error && error.message || error).slice(0, 300) });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/voice') {
      const voice = await import('./voice.mjs');
      const settings = await loadSettings(root, { env }).catch(() => ({}));
      const { textToSpeechConfig } = await import('./tts.mjs');
      const blocked = Boolean(settings && settings.voiceDisabledByPolicy);
      json(res, 200, { transcription: !blocked && voice.transcriptionReady(settings, env), speech: !blocked && Boolean(textToSpeechConfig(env, settings)), disabledByPolicy: blocked });
      return;
    }

    // Talk mode reads replies aloud with the configured speech model when there is one
    // (the page falls back to the browser's own voice otherwise).
    if (req.method === 'POST' && pathname === '/api/speak') {
      const settings = await loadSettings(root, { env }).catch(() => ({}));
      if (settings && settings.voiceDisabledByPolicy) { json(res, 403, { error: 'Voice is turned off by managed settings.' }); return; }
      const { textToSpeechConfig, synthesizeSpeech, speakableText } = await import('./tts.mjs');
      const config = textToSpeechConfig(env, settings);
      if (!config) { json(res, 409, { error: 'No speech model is configured (set OPENAI_API_KEY or OASIS_TTS_BASE_URL).' }); return; }
      const body = await readJsonBody(req, 64 * 1024);
      const text = speakableText(String(body && body.text || ''), 1500);
      if (!text) { json(res, 400, { error: 'Nothing to say.' }); return; }
      try {
        const audio = await synthesizeSpeech(config, { text, format: 'mp3' });
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'no-store' });
        res.end(audio);
      } catch (error) {
        json(res, 502, { error: String(error && error.message || error).slice(0, 300) });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readJsonBody(req, MAX_CHAT_BODY_BYTES);
      const result = await startAgentJob(body);
      json(res, 202, result);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      const stored = await taskStore.list({ limit: 100 });
      const summaries = new Map(stored.map((item) => [item.id, item]));
      for (const job of jobs.values()) {
        const lastEvent = job.events.at(-1);
        summaries.set(job.id, {
          id: job.id,
          type: job.type || 'agent',
          title: String(job.title || job.type || 'Coding task').slice(0, 160),
          status: job.status,
          createdAt: job.createdAt,
          updatedAt: lastEvent && lastEvent.at || job.createdAt,
          sessionId: job.sessionId || null,
          workspaceName: path.basename(activeRoot),
          eventCount: job.events.length,
          error: job.error || null
        });
      }
      json(res, 200, { jobs: [...summaries.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 100) });
      return;
    }


    if (req.method === 'GET' && pathname === '/api/agent-monitor') {
      const stored = await taskStore.list({ limit: 100 });
      const summaries = new Map(stored.map((item) => [item.id, item]));
      for (const job of jobs.values()) {
        const lastEvent = job.events.at(-1);
        summaries.set(job.id, {
          id: job.id, type: job.type || 'agent',
          title: String(job.title || job.type || 'Coding task').slice(0, 160),
          status: job.status, createdAt: job.createdAt,
          updatedAt: lastEvent && lastEvent.at || job.createdAt,
          sessionId: job.sessionId || null,
          workspaceName: job.workspaceName || path.basename(job.workspaceRoot || activeRoot),
          eventCount: job.events.length, error: job.error || null
        });
      }
      const allAgentRuns = [...summaries.values()]
        .filter((item) => item.type === 'agent')
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
      const recent = allAgentRuns.slice(0, 50);
      const runs = await Promise.all(recent.map(async (summary) => {
        const task = jobs.get(summary.id) || await taskStore.get(summary.id);
        return summarizeAgentRun(task || summary);
      }));
      json(res, 200, { runs: runs.filter(Boolean), total: allAgentRuns.length, updatedAt: new Date().toISOString() });
      return;
    }

    const diffMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/diff$/i);
    if (req.method === 'GET' && diffMatch) {
      const liveJob = jobs.get(diffMatch[1]);
      const task = liveJob ? await taskStore.save(liveJob) : await taskStore.get(diffMatch[1]);
      if (!task) { json(res, 404, { error: 'Task not found or expired.' }); return; }
      const artifact = task.result && task.result.isolatedWorktree;
      const branch = artifact && artifact.branch || task.worktreeBranch;
      const baseCommit = artifact && artifact.baseCommit || task.worktreeBaseCommit;
      const commit = artifact && (artifact.commitSha || artifact.commit) || null;
      const relative = artifact && artifact.path || task.worktreePath;
      const committed = Boolean(artifact && artifact.changed && commit);
      const requiresReview = Boolean(artifact && artifact.error && relative && baseCommit);
      const recoverable = !committed && (['interrupted', 'error', 'cancelled'].includes(task.status) || requiresReview);
      if (!branch || !baseCommit || !relative || (!committed && !recoverable)) { json(res, 409, { error: 'This task has no available isolated-worktree diff to review.' }); return; }
      const workspaceRoot = typeof task.workspaceRoot === 'string' ? path.resolve(task.workspaceRoot) : '';
      const primaryRoot = path.resolve(root);
      const managedWorkspaces = path.resolve(root, '.oasis', 'workspaces') + path.sep;
      if (!workspaceRoot || (workspaceRoot !== primaryRoot && !workspaceRoot.startsWith(managedWorkspaces))) { json(res, 403, { error: 'The task workspace is outside the runtime’s permitted workspace roots.' }); return; }
      if (!/^\.oasis\/worktrees\/[a-z0-9-]+$/i.test(String(relative))) { json(res, 409, { error: 'The saved isolated worktree path is invalid.' }); return; }
      if (!/^[a-f0-9]{40}$/i.test(String(baseCommit)) || (committed && !/^[a-f0-9]{7,40}$/i.test(String(commit))) || !/^oasis\/[a-z0-9-]+$/i.test(String(branch || ''))) { json(res, 409, { error: 'The saved task artifact metadata is invalid.' }); return; }
      try {
        const canonicalRoot = await realpath(workspaceRoot);
        const canonicalPrimaryRoot = await realpath(root);
        if (canonicalRoot !== canonicalPrimaryRoot) {
          const canonicalManagedWorkspaces = await realpath(path.resolve(root, '.oasis', 'workspaces'));
          if (!canonicalRoot.startsWith(canonicalManagedWorkspaces + path.sep)) { json(res, 403, { error: 'The canonical task workspace resolves outside the managed workspace directory.' }); return; }
        }
        const worktree = await realpath(path.resolve(canonicalRoot, relative));
        const managedWorktrees = path.resolve(canonicalRoot, '.oasis', 'worktrees') + path.sep;
        if (!worktree.startsWith(managedWorktrees)) { json(res, 403, { error: 'The saved worktree resolves outside its managed directory.' }); return; }
        const diff = committed
          ? await readWorktreeDiff(canonicalRoot, baseCommit, commit, { env, maxChars: 180000 })
          : await readWorktreeWorkingDiff(worktree, baseCommit, { env, maxChars: 180000 });
        let mergeReview = null;
        const recordedCommit = String(artifact && artifact.commitSha || '');
        if (committed && task.status === 'completed' && /^[a-f0-9]{40}$/i.test(recordedCommit)) {
          try {
            const inspection = await inspectWorktree(canonicalRoot, branch, { env });
            const branchMatches = inspection.branch_head.toLowerCase() === recordedCommit.toLowerCase();
            const pathMatches = inspection.worktree_path === relative;
            const alreadyIntegrated = await isCommitIntegrated(canonicalRoot, recordedCommit, { env });
            const blockedReasons = [...inspection.blocked_reasons];
            if (!branchMatches) blockedReasons.unshift('The agent branch moved after this task commit; review the current branch before merging.');
            if (!pathMatches) blockedReasons.unshift('The branch is not attached to the worktree recorded for this task.');
            if (alreadyIntegrated) blockedReasons.unshift('This task commit is already integrated into the current branch.');
            mergeReview = {
              canMerge: inspection.can_merge && branchMatches && pathMatches && !alreadyIntegrated,
              head: inspection.head,
              branchHead: inspection.branch_head,
              targetBranch: inspection.current_branch,
              blockedReasons
            };
          } catch {
            mergeReview = { canMerge: false, head: '', branchHead: '', targetBranch: '', blockedReasons: ['The isolated worktree is no longer available for safe integration.'] };
          }
        }
        json(res, 200, { branch, baseCommit, commit, complete: committed, requiresReview, status: task.status,
          files: Array.isArray(artifact && artifact.files) ? artifact.files.slice(0, 200) : [],
          untrackedFiles: Array.isArray(diff.untrackedFiles) ? diff.untrackedFiles : [],
          omittedUntracked: Number(diff.omittedUntracked) || 0,
          diffStat: String(artifact && artifact.diffStat || '').slice(0, 4000), diff: diff.diff, truncated: diff.truncated, mergeReview });
      } catch {
        json(res, 410, { error: 'The task diff is no longer available. The worktree may have been removed or its Git history changed.' });
      }
      return;
    }

    const mergeMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/merge$/i);
    if (req.method === 'POST' && mergeMatch) {
      const liveJob = jobs.get(mergeMatch[1]);
      const task = liveJob ? await taskStore.save(liveJob) : await taskStore.get(mergeMatch[1]);
      if (!task) { json(res, 404, { error: 'Task not found or expired.' }); return; }
      if (task.status !== 'completed' || (task.result && task.result.finished === false) || task.error) {
        json(res, 409, { error: 'Only successfully completed isolated tasks can be merged. Review interrupted or incomplete work without merging it.' });
        return;
      }
      const artifact = task.result && task.result.isolatedWorktree;
      const branch = artifact && artifact.branch || task.worktreeBranch;
      const baseCommit = artifact && artifact.baseCommit || task.worktreeBaseCommit;
      const commit = artifact && artifact.commitSha;
      const relative = artifact && artifact.path || task.worktreePath;
      if (!artifact || artifact.changed !== true || artifact.error || artifact.requiresReview ||
          !/^[a-f0-9]{40}$/i.test(String(commit || '')) ||
          !/^[a-f0-9]{40}$/i.test(String(baseCommit || '')) ||
          !/^oasis\/[a-z0-9-]+$/i.test(String(branch || '')) ||
          !/^\.oasis\/worktrees\/[a-z0-9-]+$/i.test(String(relative || ''))) {
        json(res, 409, { error: 'This task does not have a completed, committed isolated change ready for merge review.' });
        return;
      }
      const body = await readJsonBody(req);
      const expectedHead = String(body.expectedHead || '');
      const expectedBranchHead = String(body.expectedBranchHead || '');
      if (!/^[a-f0-9]{40}$/i.test(expectedHead) || !/^[a-f0-9]{40}$/i.test(expectedBranchHead)) {
        json(res, 400, { error: 'A full main-branch and agent-branch commit SHA from the current review is required.' });
        return;
      }
      const workspaceRoot = typeof task.workspaceRoot === 'string' ? path.resolve(task.workspaceRoot) : '';
      const primaryRoot = path.resolve(root);
      const managedWorkspaces = path.resolve(root, '.oasis', 'workspaces') + path.sep;
      if (!workspaceRoot || (workspaceRoot !== primaryRoot && !workspaceRoot.startsWith(managedWorkspaces))) {
        json(res, 403, { error: 'The task workspace is outside the runtime’s permitted workspace roots.' });
        return;
      }
      try {
        const canonicalRoot = await realpath(workspaceRoot);
        const canonicalPrimaryRoot = await realpath(root);
        if (canonicalRoot !== canonicalPrimaryRoot) {
          const canonicalManagedWorkspaces = await realpath(path.resolve(root, '.oasis', 'workspaces'));
          if (!canonicalRoot.startsWith(canonicalManagedWorkspaces + path.sep)) {
            json(res, 403, { error: 'The canonical task workspace resolves outside the managed workspace directory.' }); return;
          }
        }
        const worktree = await realpath(path.resolve(canonicalRoot, relative));
        const managedWorktrees = path.resolve(canonicalRoot, '.oasis', 'worktrees') + path.sep;
        if (!worktree.startsWith(managedWorktrees)) {
          json(res, 403, { error: 'The saved worktree resolves outside its managed directory.' }); return;
        }
        const inspection = await inspectWorktree(canonicalRoot, branch, { env });
        if (inspection.worktree_path !== relative || inspection.branch_head.toLowerCase() !== String(commit).toLowerCase()) {
          json(res, 409, { error: 'The task branch or worktree changed after the saved review. Inspect it again before merging.' });
          return;
        }
        if (await isCommitIntegrated(canonicalRoot, commit, { env })) {
          json(res, 409, { error: 'This task commit is already integrated into the current branch.' });
          return;
        }
        if (inspection.head.toLowerCase() !== expectedHead.toLowerCase() ||
            inspection.branch_head.toLowerCase() !== expectedBranchHead.toLowerCase()) {
          json(res, 409, { error: 'The main branch or agent branch changed after review. Refresh the diff and inspect it again.' });
          return;
        }
        if (!inspection.can_merge) {
          json(res, 409, { error: 'Merge blocked by the current review.', blockedReasons: inspection.blocked_reasons });
          return;
        }
        const merged = await mergeWorktree(canonicalRoot, branch, { env, expectedHead, expectedBranchHead: commit });
        const eventData = {
          branch: merged.branch, targetBranch: merged.target_branch,
          commit: merged.commit, files: merged.files.slice(0, 200)
        };
        try {
          if (liveJob) {
            emit(liveJob, 'worktree_merged', eventData);
            await taskStore.save(liveJob);
          } else {
            const nextId = Number.isSafeInteger(task.nextEventId) && task.nextEventId > 0 ? task.nextEventId : task.events.length + 1;
            task.events.push({ id: nextId, type: 'worktree_merged', at: new Date().toISOString(), data: eventData });
            task.nextEventId = nextId + 1;
            await taskStore.save(task);
          }
        } catch {
          // Git integration is durable; optional history persistence must not misreport the merge.
        }
        json(res, 200, merged);
      } catch (error) {
        json(res, 409, { error: String(error && error.message || 'The isolated worktree could not be merged safely.').slice(0, 1200) });
      }
      return;
    }

    // The full output of one finished step ("Show full output" in the app).
    const toolOutputMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/tool-output$/i);
    if (req.method === 'GET' && toolOutputMatch) {
      const job = jobs.get(toolOutputMatch[1]);
      const callId = String(parsedUrl.searchParams.get('callId') || '').slice(0, 160);
      const stored = job && callId && job.toolOutputs ? job.toolOutputs.get(callId) : null;
      if (!stored) { json(res, 404, { error: 'That step\'s full output is no longer kept. It is kept while the task is in memory on this computer.' }); return; }
      json(res, 200, { callId, text: stored.text, truncated: stored.truncated });
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})$/i);
    if (req.method === 'GET' && jobMatch) {
      const after = Math.max(0, Number.parseInt(parsedUrl.searchParams.get('after') || '0', 10) || 0);
      const job = jobs.get(jobMatch[1]);
      // ?wait=ms holds the request (up to 25 s) until the next event, so a
      // following page gets events at once instead of polling every 350 ms.
      const wait = Math.min(25_000, Math.max(0, Number.parseInt(parsedUrl.searchParams.get('wait') || '0', 10) || 0));
      if (job && wait && !TERMINAL_JOB_STATUSES.has(job.status) && !job.events.some((event) => event.id > after)) {
        await waitForJobEvent(job.id, wait, req);
        // Events come in bursts (a step's start, its output, its result):
        // wait one frame so a burst goes out as one answer.
        if (!TERMINAL_JOB_STATUSES.has(job.status)) await new Promise((resolve) => setTimeout(resolve, 16));
        if (res.destroyed || res.writableEnded) return;
      }
      if (job) {
        json(res, 200, {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt,
          now: new Date().toISOString(),
          events: job.events.filter((event) => event.id > after),
          nextEventId: job.nextEventId,
          result: job.result,
          title: job.title || null,
          type: job.type || 'agent',
          worktree: job.worktreeBranch && job.worktreePath && job.worktreeBaseCommit ? { branch: job.worktreeBranch, path: job.worktreePath, baseCommit: job.worktreeBaseCommit } : null,
          error: job.error
        });
        return;
      }
      const saved = await taskStore.get(jobMatch[1]);
      if (!saved) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      json(res, 200, {
        id: saved.id,
        status: saved.status,
        events: saved.events.filter((event) => event.id > after),
        nextEventId: saved.nextEventId,
        result: saved.result,
        title: saved.title || null,
        type: saved.type || 'agent',
        worktree: saved.worktreeBranch && saved.worktreePath && saved.worktreeBaseCommit
          ? { branch: saved.worktreeBranch, path: saved.worktreePath, baseCommit: saved.worktreeBaseCommit }
          : null,
        error: saved.error
      });
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/i);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      if (!cancelJob(job)) {
        json(res, 409, { error: 'Only a running or approval-blocked job can be cancelled.', status: job.status });
        return;
      }
      json(res, 202, { cancelRequested: true, status: job.status });
      return;
    }

    // Mid-turn steering: the running agent reads this message at its next step.
    const steerMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/steer$/i);
    if (req.method === 'POST' && steerMatch) {
      const job = jobs.get(steerMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      const body = await readJsonBody(req, 4 * MAX_STEER_CHARS + 64 * 1024);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) { json(res, 400, { error: 'Enter a message.' }); return; }
      if (message.length > MAX_STEER_CHARS) { json(res, 413, { error: 'Message is too long (' + MAX_STEER_CHARS.toLocaleString('en-US') + ' characters maximum).' }); return; }
      if (!['running', 'waiting_approval'].includes(job.status) || job.cancelRequested || !job.steerTarget) {
        json(res, 409, { error: 'That task is no longer running. Send this as a new message.', status: job.status });
        return;
      }
      if (!steerSession(job.steerTarget, message)) { json(res, 429, { error: 'Too many messages are waiting for the agent. Wait for it to read them.' }); return; }
      emit(job, 'steer_queued', { length: message.length });
      json(res, 202, { queued: true });
      return;
    }

    const answerMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/answer$/i);
    if (req.method === 'POST' && answerMatch) {
      const job = jobs.get(answerMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      const body = await readJsonBody(req);
      const pending = job.pendingApprovals.get(String(body.questionId || ''));
      if (!pending || !pending.question) { json(res, 404, { error: 'That question is no longer waiting for an answer.' }); return; }
      const answer = typeof body.answer === 'string' ? body.answer.trim().slice(0, 2000) : '';
      pending.resolve(answer);
      json(res, 200, { resolved: true, answered: Boolean(answer) });
      return;
    }

    const elicitationMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/elicitation$/i);
    if (req.method === 'POST' && elicitationMatch) {
      const job = jobs.get(elicitationMatch[1]);
      if (!job) { json(res, 404, { error: 'Job not found or expired.' }); return; }
      const body = await readJsonBody(req);
      const pending = job.pendingApprovals.get(String(body.elicitationId || ''));
      if (!pending || !pending.elicitation) { json(res, 404, { error: 'That form is no longer waiting for an answer.' }); return; }
      const action = ['accept', 'decline', 'cancel'].includes(body.action) ? body.action : null;
      if (!action) { json(res, 400, { error: 'action must be accept, decline or cancel.' }); return; }
      const content = action === 'accept' && pending.elicitation.mode === 'form' && body.content && typeof body.content === 'object' && !Array.isArray(body.content) ? body.content : undefined;
      pending.resolve({ action, ...(content ? { content } : {}) });
      json(res, 200, { resolved: true, action });
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
      if (!pending || pending.question || pending.elicitation || pending.connector) { json(res, 404, { error: 'That approval request is no longer pending.' }); return; }
      const always = approved && body.always === true && Boolean(pending.suggestion);
      pending.resolve(always ? 'always' : approved);
      json(res, 200, { resolved: true, approved, always });
      return;
    }

    json(res, 404, { error: 'Not found.' });
  }

  const cursorApi = createCursorAgentsApi({
    env, root, jobs, taskStore, trustProxy,
    activeRoot: () => activeRoot,
    startAgentJob, cancelJob, steerJob, waitForJobEvent, getConfig,
    loadSession, deleteSession, setSessionArchived,
    readJsonBody: (req) => readJsonBody(req, MAX_CHAT_BODY_BYTES),
    ...(Array.isArray(options.webhookRetryDelaysMs) ? { webhookRetryDelaysMs: options.webhookRetryDelaysMs } : {})
  });
  jobListeners.add(cursorApi.onJobEvent);

  const requestHandler = (req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, Number.isInteger(error.statusCode) ? error.statusCode : 500, { error: String(error && error.message || error || 'Oasis server error').slice(0, 3000), ...(error && error.activeJob ? { activeJob: error.activeJob } : {}) });
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
      for (const jobId of [...jobWaiters.keys()]) wakeJobWaiters(jobId);
      for (const session of activeSessions.values()) closeSession(session);
      activeSessions.clear();
      try { ptyManager.closeAll(); } catch {}
      if (server.listening) {
        // server.close() waits for every open socket. Browsers keep event streams
        // and keep-alive sockets open indefinitely, so drop idle sockets now and
        // force-close the rest after a short grace period instead of hanging.
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
        const grace = setTimeout(() => server.closeAllConnections?.(), 1000);
        grace.unref?.();
        try { await closed; } finally { clearTimeout(grace); }
      }
      // Cancelled jobs finish unwinding asynchronously and record their final
      // status. Give them a bounded moment so that status is saved, then close
      // the store so nothing writes after close() resolves.
      const settleBy = Date.now() + 3000;
      while (Date.now() < settleBy && [...jobs.values()].some((job) => ['running', 'waiting_approval', 'queued', 'starting'].includes(job.status))) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await cursorApi.settle().catch(() => {});
      await taskStore.close([...jobs.values()]);
    }
  };
}


export async function expandWebSlashCommand(root, text, env) {
  const { PermissionPolicy } = await import('./permissions.mjs');
  const settings = await loadSettings(root, { env }).catch(() => null);
  const custom = await resolveCustomCommand(root, text, { env, trusted: Boolean(settings && settings.trusted), policy: settings ? new PermissionPolicy(settings) : null, disableShell: Boolean(settings && settings.disableSkillShellExecution) });
  if (custom) return { kind: 'command', name: custom.name, prompt: custom.prompt };
  const skill = await resolveSkillCommand(root, text, { env }).catch(() => null);
  if (skill && skill.prompt) return { kind: 'skill', name: skill.name, prompt: skill.prompt };
  return null;
}

/** Every slash command the browser chat can run: built-ins, custom/plugin commands and skills. */
export async function webSlashCommands(root, env = process.env) {
  const list = [];
  const seen = new Set();
  const add = (name, description, kind) => {
    const key = String(name || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push({ name: String(name), description: String(description || '').replace(/\s+/g, ' ').slice(0, 160), kind });
  };
  for (const [name, description] of Object.entries(BUILTIN_COMMANDS)) if (!WEB_UNSUPPORTED_COMMANDS.has(name) && !WEB_TERMINAL_ONLY_COMMANDS.has(name)) add(name, description, 'builtin');
  try { for (const [name, command] of (await loadCustomCommands(root, { env })).entries()) add(name, command && command.description || 'Custom command', 'command'); } catch { /* ignore broken command folders */ }
  try {
    const { listAvailableSkills } = await import('./tools.mjs');
    for (const skill of await listAvailableSkills(root, { env })) if (skill.userInvocable !== false) add(skill.name, skill.description || 'Skill', 'skill');
  } catch { /* ignore broken skill folders */ }
  return list;
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
  // The server's env, not process.env: OASIS_CONFIG_DIR passed to the server decides where the cache goes.
  // close() aborts and awaits it, so the cache is never written after the server has closed.
  const catalogAbort = new AbortController();
  const catalogRefresh = options.refreshModelCatalog === false
    ? Promise.resolve()
    : import('./model-catalog.mjs').then(({ refreshModelCatalog, catalogRefreshDisabled }) => (catalogRefreshDisabled(process.env) ? false : refreshModelCatalog({ env: options.env || process.env, signal: catalogAbort.signal }))).catch(() => {});
  const address = app.server.address();
  const closeApp = app.close;
  return {
    ...app,
    host,
    port: address && typeof address === 'object' ? address.port : port,
    async close() {
      catalogAbort.abort();
      try { await closeApp(); } finally {
        // An aborted fetch normally settles at once; never let a stuck one hold close() open.
        let timer;
        await Promise.race([catalogRefresh, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
        clearTimeout(timer);
      }
    }
  };
}

// Only the flat, primitive schema MCP allows for forms is passed to the page, with
// lengths capped; anything else is dropped (and elicit() validates the answer anyway).
export function elicitationSchemaForPage(schema) {
  const out = { type: 'object', properties: {}, required: [] };
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
  for (const [key, prop] of Object.entries(props).slice(0, 30)) {
    if (!prop || typeof prop !== 'object' || !/^[\w.-]{1,64}$/.test(key)) continue;
    const type = ['string', 'number', 'integer', 'boolean', 'array'].includes(prop.type) ? prop.type : (Array.isArray(prop.enum) ? 'string' : null);
    if (!type) continue;
    const field = { type };
    for (const name of ['title', 'description']) { const v = text(prop[name], name === 'title' ? 120 : 500); if (v) field[name] = v; }
    const options = Array.isArray(prop.enum) ? prop.enum.map((v, i) => ({ const: v, title: Array.isArray(prop.enumNames) ? text(prop.enumNames[i], 120) : undefined }))
      : Array.isArray(prop.oneOf) ? prop.oneOf.filter((o) => o && 'const' in o).map((o) => ({ const: o.const, title: text(o.title, 120) })) : null;
    if (options) field.options = options.filter((o) => ['string', 'number', 'boolean'].includes(typeof o.const)).slice(0, 50).map((o) => ({ const: typeof o.const === 'string' ? o.const.slice(0, 200) : o.const, ...(o.title ? { title: o.title } : {}) }));
    if (type === 'array') {
      const items = prop.items && typeof prop.items === 'object' ? prop.items : {};
      const itemOptions = Array.isArray(items.enum) ? items.enum.map((v) => ({ const: v })) : Array.isArray(items.anyOf) ? items.anyOf.filter((o) => o && 'const' in o).map((o) => ({ const: o.const, title: text(o.title, 120) })) : [];
      if (!itemOptions.length) continue;
      field.options = itemOptions.filter((o) => typeof o.const === 'string').slice(0, 50).map((o) => ({ const: o.const.slice(0, 200), ...(o.title ? { title: o.title } : {}) }));
    }
    if (typeof prop.format === 'string' && ['email', 'uri', 'date', 'date-time'].includes(prop.format)) field.format = prop.format;
    for (const name of ['minimum', 'maximum', 'minLength', 'maxLength']) if (Number.isFinite(prop[name])) field[name] = prop[name];
    if (['string', 'number', 'boolean'].includes(typeof prop.default) || (Array.isArray(prop.default) && prop.default.every((v) => typeof v === 'string'))) field.default = prop.default;
    out.properties[key] = field;
  }
  if (schema && Array.isArray(schema.required)) out.required = schema.required.filter((k) => typeof k === 'string' && out.properties[k]);
  return out;
}

// Returns the file's bytes, or null when the path is no longer a regular file
// (or grew past maxBytes) once opened. O_NOFOLLOW refuses a final symlink.
export async function readRegularFileNoFollow(file, maxBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);
  const handle = await open(file, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
