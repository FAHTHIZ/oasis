#!/usr/bin/env node
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { distance as levenshtein } from 'fastest-levenshtein';
import { notifyAttention } from './attention.mjs';
import { createTerminalProgress } from './terminal-progress.mjs';
import { playSound, configureSounds, completedTodoCount, DONE_SOUND_AFTER_MS } from './sounds.mjs';
import { cronState, formatFindings } from './session-tools.mjs';
import { hasHooks as hasConfiguredHooks } from './hooks.mjs';
import { startPluginMonitorsFor } from './monitors.mjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig, getProviderSummary, carryLearnedContextWindow } from './config.mjs';
import { startIdleCompaction, idleCompactMinutes, idleCompactionNote } from './idle-compaction.mjs';
import { compactHistoryIfNeeded } from './agent.mjs';
import { applyEffort, createSession, runAgentTurn, runAgentPlan, runForkedTurn, closeSession, repairInterruptedHistory, resolveQuestionAnswer, stopFailureType, formatWait, steerSession, takeSteering } from './agent.mjs';
import { loadSession, saveSession, listSessions, pruneSessions, saveMidTurn, settleMidTurnSave, sessionRecap } from './sessions.mjs';
import { executeTool, listAvailableSkills } from './tools.mjs';
import { parseInstallIntent, planPackageInstall } from './installer.mjs';
import { listBackups, restoreBackup } from './backups.mjs';
import { runEvalCommand, evalModelPassthrough } from './eval.mjs';
import { managePlugins } from './plugins.mjs';
import { resolveImportedSlashCommand } from './extensions.mjs';
import { startOasisWebServer } from './web.mjs';
import { loadSettings, setWorkspaceTrust, addPermissionRule, PERMISSION_MODES, normalizePermissionMode, userSettingsPath } from './settings.mjs';
import { detectSandbox, resolveSandbox } from './sandbox.mjs';
import { resolveCustomCommand, expandFileMentions, loadCustomCommands, resolveSkillCommand } from './commands.mjs';
import { visionEnabled } from './images.mjs';
import { loadAgentDefinitions } from './subagents.mjs';
import { renderStatusLine, statusLinePayload } from './status-line.mjs';
import { BUILTIN_COMMANDS, COMMAND_ALIASES, runBuiltinCommand, subagentRows, createUsageTracker, recordUsage, formatInterval } from './slash.mjs';
import { appendMemoryNote } from './memory.mjs';
import { runHeadless, OUTPUT_FORMATS, headlessSetupErrorOutput } from './headless.mjs';
import { randomUUID } from 'node:crypto';
import { fstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { runDiagnostics, formatDiagnostics, CHECKERS } from './diagnostics.mjs';
import { readInput, KeyDecoder } from './line-editor.mjs';
import { loadHistory, appendHistory } from './input-history.mjs';
import { createCompleter } from './completion.mjs';
import { MarkdownStream, colorEnabled, wrapRendered } from './markdown.mjs';
import { createActivityIndicator } from './activity-indicator.mjs';
import { formatApprovalMessage, redactApprovalSecrets } from './approval-language.mjs';
import { formatTurnSummary, showStartupBanner, bannerProviderLabel, promptFor, footerFor, nextMode, runShellPassthrough, shellContextBlock, describeTool, describeEdit, describeToolResult, verboseToolOutput, describeExploration, EXPLORE_TOOLS } from './terminal-ui.mjs';
import { estimateTokens, contextWindowSize, contextTokens } from './context.mjs';
import { formatUsd, priceFor } from './pricing.mjs';
import { commandAvailable } from './command-lookup.mjs';
import { installProxyFromEnv } from './proxy.mjs';
import { doctor, updateOasis, uninstallOasis } from './cli-doctor.mjs';
import { manageMcp, manageExternalExtensions } from './cli-extensions.mjs';
import { manageSessions, backgroundCommand } from './cli-sessions.mjs';
import { autoSetup, configureProvider, pasteFirstSetup, providerKeysInEnv, connectCommand, ensureModelProviderSetup, configureSetupPrompts } from './cli-setup.mjs';
import { exitAfterTelemetry } from './telemetry.mjs';
import { printQuickHelp, printHelp, helpText } from './cli-help.mjs';

// Options that shape every agent session created by this process.
const SESSION_OPTIONS = { permissionMode: null, allowedTools: [], disallowedTools: [], appendSystemPrompt: '', model: null, effort: null, outputStyle: null, addDirs: [], pendingFiles: [], mcpServers: [], settingsOverrides: [], tools: null, channels: [], devChannels: [] };

// --plugin-url archives are intentionally session-scoped. Remove their temporary
// extraction roots on every normal process exit, including startup/error paths.
const TEMPORARY_PLUGIN_DIRS = new Set();
process.once('exit', () => {
  for (const directory of TEMPORARY_PLUGIN_DIRS) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
const USAGE = createUsageTracker();
let settingsWarningShown = false;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_URL = 'https://github.com/FAHTHIZ/oasis/archive/';

// "static passed" meant nothing to people; say what was checked.
function checkKindLabel(check) {
  if (check.kind === 'static') return check.passed ? 'files parsed cleanly' : 'file parse found problems';
  if (check.kind === 'syntax') return 'syntax check ' + (check.passed ? 'passed' : 'failed');
  return check.kind + (check.passed ? ' passed' : ' failed');
}


// While a turn runs, keystrokes are captured: Esc or Ctrl+C interrupts, Enter
// steers (the agent reads the line at its next step without stopping), and Tab
// queues the line as the next message after the turn ends.
const QUEUED_INPUT = [];
let IDLE_SUBMIT = null;

function attachCron(session) {
  if (!session) return;
  const state = cronState(session);
  state.onFire = (prompt) => {
    if (AUTO_HALT) { (state.pending ||= []).push(prompt); return; }
    if (IDLE_SUBMIT && IDLE_SUBMIT(prompt)) return;
    QUEUED_INPUT.push(prompt);
  };
  if (!AUTO_HALT && state.pending && state.pending.length) QUEUED_INPUT.push(...state.pending.splice(0));
}
// Monitor events and finished background commands wake an idle session, like
// Claude Code interjecting when a Monitor event arrives.
const WAKE_KINDS = new Set(['monitor', 'monitor-end', 'background-exit', 'background-stuck', 'agent-notice', 'mcp-task', 'channel']);
const WAKE_PREFIX = '[background event] ';
function pendingWake(session) {
  return session && Array.isArray(session.inbox) ? session.inbox.filter((entry) => WAKE_KINDS.has(entry.kind)) : [];
}
// After a non-recoverable account error (auth failure, billing, quota, account
// on hold) automatic continuations would only fail again and, on some
// providers, keep burning quota. Loops, cron prompts and background wake-ups
// pause until the user sends a message.
let AUTO_HALT = null;
function haltAutoContinue(error) {
  const kind = stopFailureType(error);
  if (kind !== 'billing_error' && kind !== 'authentication_failed') return false;
  if (!AUTO_HALT) stdout.write('[auto] Paused loops, scheduled prompts and background wake-ups after a ' + (kind === 'billing_error' ? 'billing/quota' : 'authentication') + ' error. They resume when you send the next message (fix the account or run /provider first).\n');
  AUTO_HALT = { kind, at: Date.now() };
  return true;
}
function wakeIfPending(session) {
  if (AUTO_HALT) return false;
  const pending = pendingWake(session);
  if (!pending.length || !IDLE_SUBMIT) return false;
  const labels = [...new Set(pending.map((entry) => entry.label).filter(Boolean))];
  return IDLE_SUBMIT(WAKE_PREFIX + (labels.join(', ') || pending.length + ' new event(s)').slice(0, 160));
}
let channelSession = null;
function attachMonitors(session) {
  if (!session || session.monitorsAttached) return;
  session.monitorsAttached = true;
  channelSession = session;
  let timer = null;
  session.onBackgroundEvent = (event) => {
    const last = session.inbox && session.inbox[session.inbox.length - 1];
    if (last && event) last.label = event.description || (event.kind === 'background-exit' ? 'background command ' + event.id + ' finished' : event.id);
    if (timer) return;
    timer = setTimeout(() => { timer = null; wakeIfPending(session); }, 300);
    timer.unref?.();
  };
  if (process.env.OASIS_DISABLE_PLUGIN_MONITORS !== '1') {
    session.pluginMonitorsEnabled = true;
    const started = startPluginMonitorsFor(session, 'always', { root: session.root, env: process.env });
    if (started.length) stdout.write('[monitors] ' + started.length + ' plugin monitor(s) running (/tasks to see them).\n');
    for (const error of (session.settings && session.settings.pluginMonitorErrors) || []) stdout.write('[monitors] ' + error + '\n');
  }
}
// Esc reads as Claude Code's "Interrupted · What should Claude do instead?";
// only Ctrl+C mentions that a second press quits.
export function interruptNotice(kind, color = false) {
  const text = kind === 'escape' ? '  ⎿ Interrupted · tell Oasis what to do instead' : '  ⎿ Interrupted · press Ctrl+C again to quit';
  return color ? '\x1b[31m' + text + '\x1b[39m' : text;
}
// "  ⎿ Rate limited · waiting 13s (until 14:51:00)", in the dim style of the
// provider-retry line. The compact-tools switch is said once per session.
let compactToolsNoticeShown = false;
export function rateLimitNotice(event = {}, color = false) {
  const until = event.until ? new Date(event.until) : null;
  const clock = until && !Number.isNaN(until.getTime()) ? ' (until ' + until.toTimeString().slice(0, 8) + ')' : '';
  let text = '  ⎿ Rate limited · waiting ' + formatWait(event.waitMs) + clock;
  if (event.compactTools && !compactToolsNoticeShown) {
    compactToolsNoticeShown = true;
    text += '\n  ⎿ Using the compact tool set to fit the per-minute token limit; other tools load through tool_search';
  }
  return color ? '\x1b[2m' + text + '\x1b[22m' : text;
}
let queuedDraft = '';
let turnDraft = ''; // what is typed while a turn runs, echoed in the status line
let turnKeys = null;
// A line printed between keystrokes while a turn runs: inside a streaming
// reply it goes above the partial line instead of splitting the reply.
function noticeLine(text) {
  if (markdownStream && markdownStream.started) markdownStream.interject(text);
  else stdout.write('\n' + text + '\n');
}
function startTurnKeys(onInterrupt, onSteer = null) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function' || process.env.OASIS_SIMPLE_INPUT === '1') return null;
  const decoder = new KeyDecoder();
  let buffer = '';
  let active = false;
  const dim = (text) => (colorEnabled(stdout) ? '\x1b[2m' + text + '\x1b[22m' : text);
  const onData = (chunk) => {
    for (const key of decoder.feed(chunk.toString('utf8'))) {
      if (key.name === 'escape') onInterrupt('escape');
      else if (key.name === 'ctrlC') onInterrupt('ctrlC');
      // Ctrl+O mid-turn expands the newest tool result in place (at the
      // prompt it opens the full transcript pager).
      else if (key.name === 'ctrlO') expandLastToolResult();
      else if (key.name === 'char' || key.name === 'paste') { buffer += key.text; showDraft(); }
      else if (key.name === 'backspace') { buffer = buffer.slice(0, -1); showDraft(); }
      else if ((key.name === 'enter' || key.name === 'tab') && buffer.trim()) {
        const preview = buffer.replace(/\s+/g, ' ').slice(0, 90);
        if (key.name === 'enter' && onSteer && onSteer(buffer)) {
          noticeLine(dim('  ↳ sent: ' + preview + ' · Oasis reads it at the next step (Tab queues for after the turn, Ctrl+O expands the last output)'));
        } else {
          QUEUED_INPUT.push(buffer);
          noticeLine(dim('  ↳ queued for after this turn: ' + preview));
        }
        buffer = '';
        showDraft();
      }
    }
  };
  // Type-ahead is echoed in the live status line, so typing while Oasis
  // works never feels like the keys went nowhere.
  const showDraft = () => { turnDraft = buffer; if (waitIndicator && waitIndicator.active) waitIndicator.update({ draft: buffer }); };
  const handle = {
    resume() { if (active) return; active = true; try { stdin.setRawMode(true); } catch {} stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', onData); },
    suspend() { if (!active) return; active = false; stdin.off('data', onData); try { stdin.setRawMode(false); } catch {} stdin.pause(); },
    stop() { handle.suspend(); if (buffer.trim()) queuedDraft = buffer; buffer = ''; turnDraft = ''; }
  };
  handle.resume();
  return handle;
}

async function askLine(question, external = null) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('This action needs an interactive terminal. Re-run it from a terminal session.');
  const paused = turnKeys;
  if (paused) paused.suspend();
  try { return await askLineRaw(question, external); } finally { if (paused && turnKeys === paused) paused.resume(); }
}

async function askLineRaw(question, external = null) {
  const rl = createInterface({ input: stdin, output: stdout });
  // Readline swallows Ctrl+C; forward it so a running task can be interrupted.
  const controller = new AbortController();
  if (external) { if (external.aborted) controller.abort(); else external.addEventListener('abort', () => controller.abort(), { once: true }); }
  rl.on('SIGINT', () => { controller.abort(); if (process.listenerCount('SIGINT')) process.emit('SIGINT'); });
  try { return await rl.question(question, { signal: controller.signal }); } finally { rl.close(); }
}

async function askQuestionInTerminal(question) {
  playSound('attention', { stream: stdout });
  const lines = ['', '[question] ' + (question.header ? question.header + ': ' : '') + question.question];
  question.options.forEach((option, index) => lines.push('  ' + (index + 1) + '. ' + option.label + (option.description ? ' - ' + option.description : '')));
  lines.push('  (' + (question.multiSelect ? 'numbers separated by spaces' : 'a number') + ', or type your own answer; Enter to skip)');
  stdout.write(lines.join('\n') + '\n');
  try { return resolveQuestionAnswer(question, await askLine('Answer> ')); } catch { return ''; }
}

async function askSecret(question) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Hidden API-key entry needs a real terminal. Set OASIS_API_KEY in the environment instead.');
  }
  return await new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = '';
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      stdin.off('data', onData);
      try { stdin.setRawMode(Boolean(wasRaw)); } catch {}
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (data) => {
      const text = data.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Setup cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ' && char !== '\u007f') {
          value += char;
          stdout.write('*');
        }
      }
    };
    stdout.write(question);
    try { stdin.setRawMode(true); } catch (error) { cleanup(); reject(error); return; }
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}








configureSetupPrompts({ askLine, askSecret });

function scrubChildEnvironment() {
  const env = {};
  const allow = new Set(String(process.env.OASIS_COMMAND_ENV_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean));
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|GITHUB_TOKEN|GH_TOKEN)/i.test(key) && !allow.has(key)) continue;
    if (key === 'OASIS_COMMAND_ENV_ALLOWLIST') continue;
    env[key] = value;
  }
  return env;
}

async function runInteractiveCommand(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true, env: scrubChildEnvironment() });
    child.on('error', (error) => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

// Parallel subagents can request approval at the same time; ask one question at a time.
let approvalQueue = Promise.resolve();
// The interactive session connected to an IDE, if any: edit approvals open its diff view.
let ideSession = null;
const IDE_REVIEW_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file']);
let TERMINAL_PROGRESS = null;
function terminalProgress() {
  if (!TERMINAL_PROGRESS) {
    TERMINAL_PROGRESS = createTerminalProgress({ stream: stdout });
    // Never leave a busy or error indicator on the tab after OASIS exits.
    if (TERMINAL_PROGRESS.enabled) process.once('exit', () => TERMINAL_PROGRESS.set('clear'));
  }
  return TERMINAL_PROGRESS;
}

function approve(prompt, forceInteractive = false, autoApprove = false, meta = {}) {
  if (autoApprove && !forceInteractive) return Promise.resolve(true);
  stopToolStatus();
  const progress = terminalProgress();
  const resumeState = progress.state;
  if (resumeState === 'busy') progress.set('paused');
  const next = approvalQueue.then(async () => {
    if (ideSession && ideSession.ide && meta && IDE_REVIEW_TOOLS.has(meta.tool)) {
      const { reviewEditInIde } = await import('./ide.mjs');
      stdout.write('\n[ide] Review the proposed change in ' + ideSession.ide.ideName + ' (Accept / Reject)...\n');
      const decision = await reviewEditInIde(ideSession, meta);
      if (decision !== null) { stdout.write('[ide] ' + (decision ? 'Accepted' : 'Rejected') + ' in ' + ideSession.ide.ideName + '.\n'); return decision; }
      stdout.write('[ide] The diff could not be shown in the IDE; answer here instead.\n');
    }
    // Time spent waiting for the person is not work: the turn summary leaves it out.
    const askedAt = Date.now();
    try { return await askApproval(prompt, forceInteractive, meta); } finally { CURRENT_TURN_WAITED_MS += Date.now() - askedAt; }
  });
  approvalQueue = next.catch(() => {});
  next.then(() => { if (progress.state === 'paused') progress.set(resumeState); }, () => { if (progress.state === 'paused') progress.set(resumeState); });
  return next;
}

let CURRENT_TURN_STARTED_AT = 0;
let CURRENT_TURN_WAITED_MS = 0;

async function askApproval(prompt, forceInteractive, meta) {
  // Channels that opted in to permission relay get the request too; the first answer wins.
  let relay = null;
  if (channelSession && channelSession.channels && channelSession.channels.length && meta && meta.tool) {
    const { startPermissionRelay } = await import('./channels.mjs');
    const { hookToolName } = await import('./agent.mjs');
    relay = startPermissionRelay(channelSession, { toolName: hookToolName(channelSession, meta.tool), description: String(prompt).split('\n')[0], input: meta.input });
  }
  if (!relay) return askApprovalLocal(prompt, forceInteractive, meta);
  const local = new AbortController();
  let remote = null;
  relay.promise.then((behavior) => { remote = behavior; local.abort(); });
  stdout.write('\n[channels] Also sent to your channel for approval.');
  try {
    const answer = await askApprovalLocal(prompt, forceInteractive, meta, local.signal);
    if (remote) { stdout.write('\n[channels] ' + (remote === 'allow' ? 'Approved' : 'Denied') + ' from ' + (relay.source || 'a channel') + '.\n'); return remote === 'allow'; }
    return answer;
  } finally { relay.cancel(); }
}

// Terminal rows a block of text occupies once wrapped at `columns`.
export function approvalRows(text, columns) {
  const width = Number(columns) > 0 ? Number(columns) : 80;
  return String(text).split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(stringWidth(stripAnsi(line)) / width)), 0);
}

// The approval as printed in the terminal: a risk warning in red, the command
// in the accent color, the explanation dim, and for edits the proposed diff
// (capped, colored) so the change is visible before it is allowed.
export function renderApprovalText(approval, { color = false, columns = 80, maxDiffLines = 40 } = {}) {
  const paint = (code, text) => color ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
  const lines = [];
  for (const line of String(approval && approval.message || '').split('\n')) {
    if (/^WARNING — RISKY ACTION$/.test(line)) lines.push(color ? paint('1;31', '⚠ Risky action') : line);
    else if (/^OASIS (?:wants|is asking)/.test(line)) lines.push(paint('1', line));
    else if (/^ {2}\S/.test(line)) lines.push(paint('36', line));
    else lines.push(paint('2', line));
  }
  const diff = String(approval && approval.diff || '').replace(/\s+$/, '');
  if (diff) {
    const width = Math.max(20, Number(columns) > 0 ? Number(columns) - 4 : 76);
    const rows = diff.split('\n');
    for (const row of rows.slice(0, maxDiffLines)) {
      const text = '  ' + (stringWidth(row) > width ? row.slice(0, width - 1) + '…' : row);
      if (/^(?:\+\+\+|---) /.test(row)) lines.push(paint('1', text));
      else if (row.startsWith('@@')) lines.push(paint('36', text));
      else if (row.startsWith('+')) lines.push(paint('32', text));
      else if (row.startsWith('-')) lines.push(paint('31', text));
      else lines.push(paint('2', text));
    }
    if (rows.length > maxDiffLines) lines.push(paint('2', '  … ' + (rows.length - maxDiffLines) + ' more lines'));
  }
  return lines.join('\n');
}

// The one line an answered approval leaves behind.
export function approvalSummary(chosen, meta = {}) {
  if (!chosen) return '  ⎿ Denied';
  if (chosen.value === 'always') return '  ⎿ Allowed for this session' + (meta && meta.suggestion ? ': ' + meta.suggestion : '');
  if (chosen.value === true && meta && meta.scope === 'session') return '  ⎿ Allowed for this session' + (Array.isArray(meta.sites) && meta.sites.length ? ': ' + meta.sites.join(', ') : '');
  return chosen.value === true ? '  ⎿ Allowed once' : '  ⎿ Denied';
}

async function askApprovalLocal(prompt, forceInteractive, meta, signal = null) {
  const approval = formatApprovalMessage(prompt, meta || {});
  if (process.env.OASIS_PERMISSION_PROMPTS === 'none') { stdout.write('\n[permissions] Denied without asking (--permission-prompts none): ' + approval.message.split('\n').filter(Boolean)[0] + '\n'); return false; }
  try {
    const shown = renderApprovalText(approval, { color: richOutput(), columns: stdout.columns, maxDiffLines: Math.max(6, Math.min(40, (Number(stdout.rows) || 40) - 14)) });
    stdout.write('\n' + shown + '\n');
    const approvalSound = playSound('attention', { stream: stdout });
    if (CURRENT_TURN_STARTED_AT) notifyAttention('OASIS needs your approval: ' + approval.message.split('\n').filter(Boolean)[0], { elapsedMs: Date.now() - CURRENT_TURN_STARTED_AT, soundPlayed: approvalSound, stream: stdout });
    const offerAlways = meta && meta.suggestion && !forceInteractive;
    if (signal && (!stdin.isTTY || !stdout.isTTY)) { await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 300000).unref?.(); }); return false; }
    if (stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && process.env.OASIS_LINE_APPROVALS !== '1') {
      // Claude Code-style dialog: arrows/j/k + Enter, 1-3, y/n/a, Esc; rebindable via the Confirmation context.
      const { selectDialog } = await import('./select-dialog.mjs');
      // A site approval holds for the session, so its button says so.
      const options = [{ label: meta && meta.scope === 'session' ? 'Allow for this session' : 'Allow once', value: true, hotkey: 'yes' }];
      if (offerAlways) options.push({ label: 'Always allow this session for ' + meta.suggestion, value: 'always', hotkey: 'always' });
      options.push({ label: 'No', value: false, hotkey: 'no' });
      stdout.write((richOutput() ? '\x1b[1mDo you want to proceed?\x1b[22m' : 'Do you want to proceed?') + '\n');
      const paused = turnKeys;
      if (paused) paused.suspend();
      // Rows printed above the options: the blank line, the message (wrapped
      // at the terminal width) and the question.
      const collapse = { rows: approvalRows('\n' + shown + '\nDo you want to proceed?', stdout.columns), summary: (chosen) => approvalSummary(chosen, meta) };
      try { return await selectDialog({ input: stdin, output: stdout, options, color: colorEnabled(stdout), signal, collapse }); }
      finally { if (paused && turnKeys === paused) paused.resume(); }
    }
    const answer = (await askLine(offerAlways ? 'Allow once [y] / [N]o / [a]lways allow ' + meta.suggestion + ' this session: ' : (meta && meta.scope === 'session' ? 'Allow for this session? [y/N] ' : 'Allow once? [y/N] '), signal)).trim().toLowerCase();
    if (offerAlways && ['a', 'always'].includes(answer)) return 'always';
    return ['y', 'yes'].includes(answer);
  } catch {
    if (signal && signal.aborted) return false;
    stdout.write('No interactive approval was available; action denied.\n');
    return false;
  }
}

// Streaming: print assistant text as it arrives; onText then only ends the line.
let streamedSoFar = '';
let markdownStream = null;
const richOutput = () => colorEnabled(stdout) && process.env.OASIS_PLAIN_OUTPUT !== '1';
let waitIndicator = null;
// Claude Code's spinnerVerbs, refreshed from the session settings before each prompt.
let spinnerVerbsSetting = null;
function onModelWait(event = {}) {
  if (event.phase === 'progress') { if (waitIndicator) waitIndicator.update({ promptProgress: event.promptProgress }); return; }
  if (event.phase !== 'start') { stopWaitIndicator(); return; }
  flushExploration();
  // A new request means the previous reply is over (a gate can re-prompt
  // without onText). End its open line first: the spinner clears the current
  // row, and the next reply must not be diffed against the old text.
  endText();
  if (!waitIndicator) waitIndicator = createActivityIndicator({ stream: stdout, env: process.env, color: richOutput(), verbs: () => spinnerVerbsSetting });
  waitIndicator.start(turnDraft ? { ...event, draft: turnDraft } : event);
}
// The first rate-limit wait in a turn gets a dim line; later ones count down in
// the spinner instead of stacking "Rate limited" lines. Without a live
// spinner (pipes, CI, reduced motion) every wait is still printed.
let rateLimitWaitsThisTurn = 0;
function onRateLimitWait(event = {}) {
  stopWaitIndicator();
  if (!waitIndicator) waitIndicator = createActivityIndicator({ stream: stdout, env: process.env, color: richOutput(), verbs: () => spinnerVerbsSetting });
  const live = waitIndicator.level !== 'off';
  if (!live || rateLimitWaitsThisTurn++ === 0 || (event.compactTools && !compactToolsNoticeShown)) process.stderr.write(rateLimitNotice(event, colorEnabled(process.stderr)) + '\n');
  if (live) waitIndicator.start({ rateLimitMs: Number(event.waitMs) || 0 });
}
function stopWaitIndicator() { flushExploration(); toolStatusCall = null; if (waitIndicator) waitIndicator.stop(); }
// The status line while a command runs (started by its first output, which
// comes only after any approval). Shows the newest output line.
let toolStatusCall = null;
let lastToolResult = null;
function expandLastToolResult() {
  const last = lastToolResult;
  if (!last) { noticeLine((colorEnabled(stdout) ? '\x1b[2m' : '') + '  ↳ No tool output to expand yet.' + (colorEnabled(stdout) ? '\x1b[22m' : '')); return; }
  const shown = verboseToolOutput(last.name, last.result, { color: colorEnabled(stdout), maxLines: 400 });
  noticeLine((colorEnabled(stdout) ? '\x1b[2m' : '') + '  ↳ Full output of ' + last.name + ':' + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n' + (shown || '  ⎿ (no output)'));
}
// Command results (/cost, /status, ...) are plain lines; on a terminal they
// word-wrap like replies instead of breaking mid-word at the edge. A line
// that fills the row exactly (pre-wrapped /help) is left alone.
export function wrapCommandOutput(text, columns = 80) {
  return String(text).split('\n').map((line) => wrapRendered(line, Number(columns) + 1)).join('\n');
}
export function lastOutputLine(text, max = 60) {
  const lines = stripAnsi(String(text || '')).split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
function liveToolStatus(event = {}) {
  if (!event.call) return;
  if (!waitIndicator) waitIndicator = createActivityIndicator({ stream: stdout, env: process.env, color: richOutput(), verbs: () => spinnerVerbsSetting });
  if (waitIndicator.level === 'off') return;
  const line = lastOutputLine(event.text);
  if (toolStatusCall !== event.call.id || !waitIndicator.active) {
    endText();
    toolStatusCall = event.call.id;
    const args = safeArgs(event.call);
    const detail = String(event.name === 'run_command' ? [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' ') : args.command || '').replace(/\s+/g, ' ').trim();
    // The step header right above already shows the whole command; the
    // status names only a short one ("Running npm test") so the line keeps
    // room for the clock and the newest output.
    waitIndicator.start({ label: detail && detail.length <= 24 ? 'Running ' + detail : 'Running command', detail: line, ...(turnDraft ? { draft: turnDraft } : {}) });
  } else if (line) waitIndicator.update({ detail: line });
}
function safeArgs(call) { try { return JSON.parse(call.function && call.function.arguments || '{}'); } catch { return {}; } }
function stopToolStatus(call) { if (toolStatusCall && (!call || call.id === toolStatusCall)) { toolStatusCall = null; if (waitIndicator) waitIndicator.stop(); } }
// Read-only lookups (reads, searches, listings) are held until the batch ends,
// then shown as one "Read 3 files, searched 1 pattern" line. Failures, and a
// lone lookup, keep the usual header and result lines.
let explorationBatch = [];
function holdExploration(event) {
  if (waitIndicator) waitIndicator.stop();
  endText();
  explorationBatch.push({ id: event.call && event.call.id, name: event.name, args: event.args || {}, event, done: false, result: null });
}
function exploredResult(call, result) {
  const item = call && explorationBatch.find((entry) => entry.id === call.id && !entry.done);
  if (!item) return false;
  item.done = true;
  item.result = result;
  return true;
}
function flushExploration() {
  if (!explorationBatch.length) return;
  const items = explorationBatch;
  explorationBatch = [];
  const failed = (item) => !item.done || (item.result && item.result.error);
  const ok = items.filter((item) => !failed(item));
  const single = (item) => {
    stdout.write('\n' + describeTool(item.event, { color: true }) + '\n');
    if (!item.done) return;
    const summary = describeToolResult(item.name, item.result, { color: true });
    if (summary) stdout.write(summary + '\n');
    else if (item.result && item.result.error) stdout.write('[tool result] ' + item.name + ': ' + String(item.result.error).slice(0, 700) + '\n');
  };
  if (ok.length > 1) stdout.write('\n' + describeExploration(ok, { color: true }) + '\n');
  else ok.forEach(single);
  items.filter(failed).forEach(single);
}
function streamDelta(accumulated) {
  stopWaitIndicator();
  const text = String(accumulated || '');
  // An empty update means the stream restarted; onStreamRestart ends the line.
  if (!text) return;
  if (richOutput()) {
    if (!markdownStream) markdownStream = new MarkdownStream({ write: (chunk) => stdout.write(chunk), color: true, columns: () => stdout.columns || 80, prefix: '\x1b[38;2;251;191;36m●\x1b[39m ' });
    if (text.startsWith(streamedSoFar)) markdownStream.push(text.slice(streamedSoFar.length));
    streamedSoFar = text || ' ';
    return;
  }
  if (!streamedSoFar) stdout.write('\nOasis> ');
  if (text.startsWith(streamedSoFar)) stdout.write(text.slice(streamedSoFar.length));
  streamedSoFar = text || ' ';
}
function endStream() {
  stopWaitIndicator();
  return endText();
}
function endText() {
  if (!streamedSoFar) return false;
  if (markdownStream) { markdownStream.end(); markdownStream = null; }
  else stdout.write('\n');
  streamedSoFar = '';
  return true;
}

function describeToolStart({ name, args = {}, subagent }) {
  let detail = '';
  if (name === 'run_command') detail = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
  else if (name === 'run_shell' || name === 'auto_test') detail = String(args.command || '');
  else if (name === 'task') detail = (args.subagent_type || 'general-purpose') + ': ' + (args.description || '');
  else if (args.path || args.pattern || args.query || args.url) detail = String(args.path || args.pattern || args.query || args.url);
  if (detail.length > 140) detail = detail.slice(0, 137) + '...';
  return (subagent ? '  [' + subagent + '] ' : '[tool] ') + name + (detail ? ' ' + detail : '');
}

// Loads values for flags that accept a file path or inline JSON.
async function readFlagValue(value, root) {
  const text = String(value || '').trim();
  if (text.startsWith('{') || text.startsWith('[')) return text;
  return readFile(path.resolve(root, text.startsWith('@') ? text.slice(1) : text), 'utf8');
}

async function resolveFlagFiles(root) {
  for (const item of SESSION_OPTIONS.pendingFiles.splice(0)) {
    if (item.kind === 'subagent-append') {
      const text = await readFile(path.resolve(root, item.file), 'utf8').catch((error) => { throw new Error('Could not read ' + item.file + ': ' + error.message); });
      SESSION_OPTIONS.subagentSystemAppend = [SESSION_OPTIONS.subagentSystemAppend, text].filter(Boolean).join('\n\n');
      continue;
    }
    if (item.kind === 'system' || item.kind === 'append') {
      const text = await readFile(path.resolve(root, item.file), 'utf8').catch((error) => { throw new Error('Could not read ' + item.file + ': ' + error.message); });
      if (item.kind === 'system') SESSION_OPTIONS.systemPromptOverride = text;
      else SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, text].filter(Boolean).join('\n\n');
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(await readFlagValue(item.file, root)); }
    catch (error) { throw new Error('--' + (item.kind === 'mcp' ? 'mcp-config' : item.kind) + ' is not valid JSON or a readable JSON file: ' + error.message); }
    if (item.kind === 'mcp') {
      const { parseMcpServerEntries } = await import('./mcp-project.mjs');
      const { servers, failures } = parseMcpServerEntries(parsed, process.env, 'flag');
      for (const failure of failures) stderr.write('[mcp] ' + failure.name + ': ' + failure.error + '\n');
      SESSION_OPTIONS.mcpServers.push(...servers);
    } else if (item.kind === 'settings') {
      SESSION_OPTIONS.settingsOverrides.push({ settings: parsed, file: item.file.trim().startsWith('{') ? '--settings' : path.resolve(root, item.file) });
      if (parsed && typeof parsed.model === 'string' && !SESSION_OPTIONS.model) SESSION_OPTIONS.model = parsed.model;
    } else if (item.kind === 'agents') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--agents must be a JSON object like {"reviewer": {"description": "...", "prompt": "..."}}.');
      SESSION_OPTIONS.agentsInline = { ...(SESSION_OPTIONS.agentsInline || {}), ...parsed };
    }
  }
  if (SESSION_OPTIONS.fromPr) {
    const pr = spawnSync('gh', ['pr', 'view', String(SESSION_OPTIONS.fromPr), '--json', 'number,title,body,headRefName,baseRefName,url,files'], { cwd: root, encoding: 'utf8', timeout: 20000 });
    if (pr.status !== 0) throw new Error('--from-pr: could not read the pull request with the GitHub CLI: ' + (pr.stderr || pr.error && pr.error.message || 'unknown error').trim());
    const info = JSON.parse(pr.stdout);
    const diff = spawnSync('gh', ['pr', 'diff', String(SESSION_OPTIONS.fromPr)], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, 'This session is linked to pull request #' + info.number + ' (' + info.url + '): ' + info.title + '\nBranch: ' + info.headRefName + ' → ' + info.baseRefName + '\nDescription:\n' + String(info.body || '').slice(0, 6000) + '\n\nChanged files: ' + (info.files || []).map((file) => file.path).join(', ').slice(0, 4000) + (diff.status === 0 ? '\n\nDiff (truncated):\n' + String(diff.stdout).slice(0, 40000) : '')].filter(Boolean).join('\n\n');
  }
}

function sessionCreateOptions() {
  // --session-id names only the first session; later ones (after /clear) get fresh ids.
  const firstSessionId = SESSION_OPTIONS.sessionId || null;
  SESSION_OPTIONS.sessionId = null;
  return {
    onHookStatus: (event) => { if (event.phase === 'start') onModelWait({ phase: 'start', label: event.label }); else stopWaitIndicator(); },
    permissionMode: SESSION_OPTIONS.permissionMode,
    allowedTools: SESSION_OPTIONS.allowedTools,
    disallowedTools: SESSION_OPTIONS.disallowedTools,
    appendSystemPrompt: SESSION_OPTIONS.appendSystemPrompt,
    outputStyle: SESSION_OPTIONS.outputStyle || null,
    addDirs: SESSION_OPTIONS.addDirs,
    bare: Boolean(SESSION_OPTIONS.bare || SESSION_OPTIONS.safeMode),
    restricted: Boolean(SESSION_OPTIONS.restricted),
    subagentSystemAppend: SESSION_OPTIONS.subagentSystemAppend || '',
    excludeDynamicSections: Boolean(SESSION_OPTIONS.excludeDynamicSections),
    systemPromptSnapshot: SESSION_OPTIONS.systemPromptSnapshot || null,
    systemPromptOverride: SESSION_OPTIONS.systemPromptOverride || '',
    tools: SESSION_OPTIONS.tools,
    mcpServers: SESSION_OPTIONS.mcpServers,
    strictMcpConfig: Boolean(SESSION_OPTIONS.strictMcpConfig),
    agentsInline: SESSION_OPTIONS.agentsInline || null,
    sessionName: SESSION_OPTIONS.sessionName || '',
    sessionId: firstSessionId,
    fallbackModel: SESSION_OPTIONS.fallbackModel || '',
    advisor: SESSION_OPTIONS.advisor || '',
    chrome: SESSION_OPTIONS.chrome === undefined ? null : SESSION_OPTIONS.chrome,
    maxBudgetUsd: SESSION_OPTIONS.maxBudgetUsd || 0,
    settingsOverrides: SESSION_OPTIONS.settingsOverrides,
    settingSources: SESSION_OPTIONS.settingSources || null,
    agent: SESSION_OPTIONS.agent || null,
    skipAgentInitialPrompt: Boolean(SESSION_OPTIONS.agentInitialPromptSent),
    channels: [...SESSION_OPTIONS.channels, ...(SESSION_OPTIONS.devChannelsConfirmed ? SESSION_OPTIONS.devChannels : [])]
  };
}

// Hook output and Oasis's own notices share session.hookMessages. Notices that
// carry their own tag ([fallback], [key-pool], [session]) printed as
// "[hook] [fallback] …", as if a user hook had switched the model.
export function sessionNoticeLine(message) {
  const text = String(message).slice(0, 800);
  return /^\[(?:fallback|key-pool|session)\] /.test(text) ? text : '[hook] ' + text;
}

function reportSessionNotices(session) {
  if (!session) return;
  if (!settingsWarningShown) {
    settingsWarningShown = true;
    if (session.settingsError) stdout.write('[settings] ' + session.settingsError + '\n');
    if (session.modelRestrictionNote) stdout.write('[settings] ' + session.modelRestrictionNote + '\n');
    if (session.styleWarning) stdout.write('[settings] ' + session.styleWarning + '\n');
    if (session.agentWarning) stdout.write('[settings] ' + session.agentWarning + '\n');
    else if (session.mainAgent) stdout.write('[agent] Running as ' + session.mainAgent + (session.settings && session.settings.agentSource && !SESSION_OPTIONS.agent ? ' (from ' + session.settings.agentSource + ' settings)' : '') + '.\n');
    for (const note of session.instructionNotices || []) stdout.write('[instructions] ' + note + ' Split it or move detail into @imports / .claude/rules/.\n');
    for (const note of session.localContextNotices || []) stdout.write('[local model] ' + note + '\n');
    for (const item of session.rejectedDirectories || []) stdout.write('[settings] Additional directory ' + item.dir + ' was not added: ' + item.error + '.\n');
    if (session.additionalDirectories && session.additionalDirectories.length) stdout.write('[settings] Additional directories: ' + session.additionalDirectories.join(', ') + '\n');
    const ignored = session.settings && session.settings.ignoredUntrusted || [];
    if (ignored.length) stdout.write('[settings] This workspace is not trusted, so allow rules, hooks, and mode/sandbox changes in ' + ignored.map((file) => path.relative(session.root, file)).join(', ') + ' were ignored. Deny/ask rules still apply. Run oasis trust after reviewing them.\n');
    if (session.sandbox && session.sandbox.enabled) stdout.write(session.sandbox.available ? '[sandbox] Commands run inside ' + session.sandbox.kind + (session.sandbox.network ? '' : ' with network disabled') + '.\n' : '[sandbox] Requested but unavailable: ' + session.sandbox.reason + '\n');
  }
  if (Array.isArray(session.hookMessages) && session.hookMessages.length) {
    for (const message of session.hookMessages.splice(0)) stdout.write(sessionNoticeLine(message) + '\n');
  }
}

async function managePermissions(root, rest) {
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    const settings = await loadSettings(root);
    stdout.write('Permission mode: ' + settings.permissions.defaultMode + (SESSION_OPTIONS.permissionMode ? ' (overridden: ' + SESSION_OPTIONS.permissionMode + ')' : '') + '\n');
    stdout.write('Workspace trusted: ' + (settings.trusted ? 'yes' : 'no') + '\n');
    for (const kind of ['allow', 'ask', 'deny']) stdout.write(kind + ': ' + (settings.permissions[kind].length ? settings.permissions[kind].join(', ') : '(none)') + '\n');
    const hookEvents = Object.entries(settings.hooks).map(([event, groups]) => event + ' x' + groups.reduce((n, g) => n + g.hooks.length, 0));
    stdout.write('hooks: ' + (hookEvents.length ? hookEvents.join(', ') : '(none)') + '\n');
    const probe = detectSandbox();
    stdout.write('sandbox: ' + (settings.sandbox.enabled ? 'enabled' : 'disabled') + ' (' + (probe.available ? probe.kind + ' available' : probe.reason) + ')\n');
    stdout.write('Settings files: ' + (settings.sources.map((item) => item.file).join(', ') || userSettingsPath() + ' (not created yet)') + '\n');
    if (settings.ignoredUntrusted.length) stdout.write('Ignored until trusted: ' + settings.ignoredUntrusted.join(', ') + '\n');
    return;
  }
  if (sub === 'add') {
    const kind = rest[1];
    const rule = rest[2];
    const scopeIndex = rest.indexOf('--scope');
    const scope = scopeIndex >= 0 ? rest[scopeIndex + 1] : 'local';
    const file = await addPermissionRule(scope, kind, rule, root);
    stdout.write('Added ' + kind + ' rule ' + rule + ' to ' + file + '\n');
    return;
  }
  stdout.write('Usage: oasis permissions [list] | oasis permissions add allow|ask|deny "RULE" [--scope user|project|local]\n');
}

async function authCommand(root, rest) {
  const auth = await import('./auth-cli.mjs');
  const [sub = 'status', ...more] = rest;
  const options = auth.parseAuthArgs(more);
  if (sub === 'status') {
    const status = await auth.authStatus(process.env);
    stdout.write(options.text ? auth.describeAuthStatus(status) + '\n' : JSON.stringify(status, null, 2) + '\n');
    process.exitCode = status.loggedIn ? 0 : 1;
    return;
  }
  if (sub === 'logout') {
    const out = await auth.authLogout(process.env);
    stdout.write((out.removed ? 'Removed the stored API key from ' + out.file + '.' : 'No stored API key in ' + out.file + '.') + (out.envKeys.length ? ' Still set in your environment: ' + out.envKeys.join(', ') + ' (unset them to fully sign out).' : '') + '\n');
    return;
  }
  if (sub === 'login') {
    if (options.apiKeyStdin) options.apiKey = (await readPipedStdin()).trim();
    if (options.ignored) stderr.write('[auth] ' + options.ignored.join(', ') + ' only apply to Anthropic account sign-in; OASIS signs in with a provider API key.\n');
    if (options.apiKey) {
      const status = await auth.authLoginWithKey(options, process.env);
      stdout.write(auth.describeAuthStatus(status) + '\n');
      return;
    }
    if (!stdin.isTTY) throw new Error('Usage: oasis auth login --api-key KEY | --api-key-stdin [--protocol anthropic|openai-compatible|openai-responses] [--base-url URL] [--model ID]');
    return await configureProvider(root);
  }
  throw new Error('Usage: oasis auth status [--text] | login [--api-key KEY|--api-key-stdin] [--protocol P] [--base-url URL] [--model ID] | logout');
}

// Claude's setup-token mints an OAuth token; OASIS uses provider keys, so it prints how to pass one to CI.
async function setupTokenCommand() {
  const auth = await import('./auth-cli.mjs');
  const status = await auth.authStatus(process.env);
  stdout.write([
    'OASIS uses your model provider\'s API key rather than an account token.',
    'For CI and scripts, store the key as a secret and expose it as an environment variable:',
    '  ' + (status.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : status.protocol === 'bedrock' ? 'AWS_BEARER_TOKEN_BEDROCK (or AWS credentials)' : status.protocol === 'vertex' ? 'GOOGLE_APPLICATION_CREDENTIALS' : status.protocol === 'foundry' ? 'ANTHROPIC_FOUNDRY_API_KEY' : 'OASIS_API_KEY') + '=<your key>',
    '  OASIS_PROTOCOL=' + (status.protocol || 'anthropic') + (status.model ? '  OASIS_MODEL=' + status.model : '') + (status.baseURL && !/api\.anthropic\.com|api\.openai\.com/.test(status.baseURL) ? '  OASIS_BASE_URL=' + status.baseURL : ''),
    'Then run: oasis -p "your task" --output-format json',
    'Or use an apiKeyHelper script in settings to fetch a short-lived key at request time.'
  ].join('\n') + '\n');
}

async function agentsCommand(rest) {
  const { agentsJson } = await import('./auth-cli.mjs');
  const cwdIndex = rest.indexOf('--cwd');
  const list = await agentsJson({ all: rest.includes('--all'), cwd: cwdIndex >= 0 ? rest[cwdIndex + 1] : null }, process.env);
  if (rest.includes('--json')) stdout.write(JSON.stringify(list, null, 2) + '\n');
  else stdout.write(list.length ? list.map((entry) => entry.id + '  ' + entry.status.padEnd(9) + ' ' + (entry.name || '') + '  ' + entry.prompt.replace(/\s+/g, ' ').slice(0, 70)).join('\n') + '\n' : 'No background sessions.\n');
}

// `oasis ultrareview [target] [--json] [--timeout MIN] [--post]`: the deep review, non-interactively.
async function ultrareviewCommand(root, rest, autoApprove, persistence) {
  const words = [];
  let json = false; let post = false; let minutes = 45;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--post') post = true;
    else if (arg === '--no-post') post = false;
    else if (arg === '--timeout') minutes = Math.max(1, Number.parseFloat(rest[++i]) || 45);
    else if (arg.startsWith('--timeout=')) minutes = Math.max(1, Number.parseFloat(arg.split('=')[1]) || 45);
    else words.push(arg);
  }
  const target = words.join(' ');
  if (post && !/^#?\d+$|github\.com\/.+\/pull\/\d+/.test(target)) throw new Error('--post needs a GitHub pull request target (a number or a github.com pull request URL).');
  const prNumber = (target.match(/\/pull\/(\d+)/) || [])[1];
  const { reviewPrompt } = await import('./slash.mjs');
  let prompt = reviewPrompt('review', 'ultra ' + (prNumber || target));
  prompt += post
    ? '\n\nWhen the review is complete, post the findings to the pull request as ONE plain comment with `gh pr comment ' + (prNumber || target.replace('#', '')) + ' --body-file -` and say that you did.'
    : '\n\nDo not post anything to GitHub and do not change files: print the findings only.';
  if (json) prompt += '\n\nRecord the confirmed findings with report_findings (pass [] when there are none); the JSON result carries them in its findings field.';
  const timer = setTimeout(() => { stderr.write('OASIS error: ultrareview timed out after ' + minutes + ' minutes.\n'); process.exit(1); }, minutes * 60000);
  timer.unref();
  try {
    if (post) SESSION_OPTIONS.allowedTools.push('Bash(gh pr comment:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)');
    else SESSION_OPTIONS.allowedTools.push('Bash(gh pr view:*)', 'Bash(gh pr diff:*)');
    SESSION_OPTIONS.disallowedTools.push('Write', 'Edit');
    await printMode(root, { prompt, outputFormat: json ? 'json' : 'text' }, [], autoApprove, persistence);
  } finally { clearTimeout(timer); }
}


// oasis auto-mode defaults [--label PREFIX] | config | critique | reset [--yes]  (claude auto-mode ...)
async function autoModeCommand(root, rest, autoApprove = false) {
  const { DEFAULT_AUTO_MODE, AUTO_MODE_SECTIONS, effectiveAutoModeConfig, critiqueAutoMode, ruleLabel } = await import('./auto-mode.mjs');
  const [sub = 'config', ...more] = rest;
  const labelAt = more.indexOf('--label');
  const label = labelAt >= 0 ? String(more[labelAt + 1] || '').toLowerCase() : '';
  const filter = (config) => {
    if (!label) return config;
    const out = {};
    for (const section of AUTO_MODE_SECTIONS) out[section] = (config[section] || []).filter((rule) => ruleLabel(rule).toLowerCase().startsWith(label));
    return out;
  };
  const settings = await loadSettings(root);
  if (sub === 'defaults') { stdout.write(JSON.stringify(filter(DEFAULT_AUTO_MODE), null, 2) + '\n'); return; }
  if (sub === 'config') {
    const config = effectiveAutoModeConfig(settings.autoMode);
    if (settings.autoMode && settings.autoMode.rules && settings.autoMode.rules.length) config.rules = settings.autoMode.rules;
    if (settings.autoMode && settings.autoMode.classifyAllShell) config.classifyAllShell = true;
    stdout.write(JSON.stringify(filter(config), null, 2) + '\n');
    return;
  }
  if (sub === 'critique') { stdout.write(critiqueAutoMode(settings.autoMode).map((note) => '- ' + note).join('\n') + '\n'); return; }
  if (sub === 'reset') {
    const file = userSettingsPath(process.env);
    const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}') || '{}');
    if (!current.autoMode) { stdout.write('No autoMode section in ' + file + '; the defaults already apply.\n'); return; }
    stdout.write('This removes the autoMode section from ' + file + ': ' + Object.keys(current.autoMode).join(', ') + '. Rules from managed settings or --settings still apply.\n');
    if (!autoApprove && !more.includes('--yes') && !more.includes('-y') && !(await approve('Reset auto mode configuration to defaults?', true, false))) { stdout.write('Kept your auto mode rules.\n'); return; }
    const { updateUserSettings } = await import('./settings.mjs');
    await updateUserSettings((data) => { delete data.autoMode; return data; }, process.env);
    stdout.write('Auto mode configuration reset to defaults.\n');
    return;
  }
  throw new Error('Usage: oasis auto-mode defaults [--label PREFIX] | config [--label PREFIX] | critique | reset [--yes]');
}

// --verbose / "verbose": true / /config verbose: show tool output in the transcript.
function verboseEnabled(session) {
  if (typeof SESSION_OPTIONS.verbose === 'boolean') return SESSION_OPTIONS.verbose;
  return Boolean(session && session.settings && session.settings.verbose);
}

async function purgeCommand(root, rest, autoApprove) {
  const { parsePurgeArgs, planPurge, applyPurge, describePurge, knownProjects } = await import('./purge.mjs');
  const options = parsePurgeArgs(rest);
  if (autoApprove) options.yes = true;
  let targets = [];
  if (options.all) targets = (await knownProjects(process.env)).map((item) => item.root);
  else if (options.path) targets = [path.resolve(options.path)];
  else {
    const projects = await knownProjects(process.env);
    if (!projects.length) { stdout.write('No projects have saved Oasis state.\n'); return; }
    if (!(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function')) throw new Error('Usage: oasis purge PATH | --all. Projects with saved state:\n' + projects.map((item) => '  ' + item.root + ' (' + item.sessions + ' sessions)').join('\n'));
    const { selectDialog } = await import('./select-dialog.mjs');
    stdout.write('Select a project to purge:\n');
    const chosen = await selectDialog({ input: stdin, output: stdout, options: projects.map((item) => ({ label: item.root + '  (' + item.sessions + ' session' + (item.sessions === 1 ? '' : 's') + ')', value: item.root })), context: 'Select', color: colorEnabled(stdout) });
    if (!chosen) { stdout.write('Cancelled.\n'); return; }
    targets = [chosen];
  }
  if (!targets.length) { stdout.write('No projects have saved Oasis state.\n'); return; }
  for (const target of targets) {
    const plan = await planPurge(target, { env: process.env, memory: options.memory });
    stdout.write(describePurge(plan) + '\n');
    if (!plan.items.length || options.dryRun) { if (options.dryRun && plan.items.length) stdout.write('(dry run — nothing deleted)\n'); continue; }
    if (!options.yes && !options.interactive && !(await approve('Delete all of this? It cannot be undone.', true, false))) { stdout.write('Kept ' + target + '.\n'); continue; }
    const done = await applyPurge(plan, { env: process.env, confirm: options.interactive && !options.yes ? (item) => approve('Delete ' + item.label + '?', true, false) : null });
    stdout.write('Purged ' + done.length + ' item' + (done.length === 1 ? '' : 's') + ' for ' + target + '.\n');
  }
}

async function importCommand(root, rest, autoApprove) {
  const { planImport, describePlan, applyImport, parseImportArgs } = await import('./importers.mjs');
  const { sources, dryRun, yes } = parseImportArgs(rest);
  const plan = await planImport(root, { sources, env: process.env });
  stdout.write(describePlan(plan) + '\n');
  const pending = plan.items.filter((item) => item.action !== 'skip');
  if (!pending.length || dryRun) { if (dryRun && pending.length) stdout.write('Dry run: nothing was written.\n'); return; }
  if (!yes && !(await approve('Import these ' + pending.length + ' item' + (pending.length === 1 ? '' : 's') + '?', true, autoApprove))) { stdout.write('Import cancelled.\n'); return; }
  const done = await applyImport(plan);
  stdout.write('Imported ' + done.length + ' item' + (done.length === 1 ? '' : 's') + '. New MCP servers, commands and rules apply to new sessions.\n');
}

async function manageTrust(root, rest) {
  const revoke = rest.includes('--revoke');
  const id = await setWorkspaceTrust(root, !revoke);
  stdout.write((revoke ? 'Revoked trust for ' : 'Trusted ') + id + '. ' + (revoke ? 'Project allow rules and hooks are ignored again.' : 'Project allow rules, hooks, and sandbox/mode settings now apply. Review .oasis/ and .claude/ settings files before trusting a repository you did not write.') + '\n');
}

async function selfUpdate(autoApprove = false) {
  if (!commandAvailable('npm')) throw new Error('npm was not found. Install Node.js with npm, then rerun oasis update.');
  const { latestReleaseCommit } = await import('./update.mjs');
  const latest = await latestReleaseCommit();
  const installUrl = INSTALL_URL + latest.sha + '.tar.gz';
  const command = 'npm';
  const args = ['install', '--global', installUrl];
  stdout.write('Oasis self-update plan\n  ' + command + ' ' + args.join(' ') + '\n');
  stdout.write('This installs the latest stable release ' + latest.tag + ' from its immutable source archive.\n');
  if (!(await approve('Install/update Oasis from stable release ' + latest.tag + ' (' + latest.sha.slice(0, 7) + ')?', false, autoApprove))) {
    stdout.write('Update cancelled.\n');
    return;
  }
  const result = await runInteractiveCommand(command, args);
  if (result.code === 0) stdout.write('Oasis CLI update completed.\n');
  else stdout.write('Oasis CLI update failed' + (result.code === null ? ': ' + result.error : ' with exit code ' + result.code) + '.\n');
}

async function diagnosticsCommand(rest, root, autoApprove) {
  const paths = [];
  let checker = 'auto';
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--checker') checker = rest[++i] || '';
    else if (arg.startsWith('--checker=')) checker = arg.slice('--checker='.length);
    else if (arg.startsWith('-')) throw new Error('Usage: oasis diagnostics [PATH...] [--checker auto|' + CHECKERS.join('|') + '] [--json]');
    else paths.push(arg);
  }
  const settings = await loadSettings(root).catch(() => ({}));
  const sandbox = resolveSandbox(settings, root);
  const result = await runDiagnostics(root, { checker, paths }, {
    autoApprove, env: process.env, sandbox,
    approval: (message, forceInteractive = false) => approve(message, forceInteractive, autoApprove)
  });
  stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : formatDiagnostics(result) + '\n');
  if (result.summary.errors) process.exitCode = 1;
  return result;
}

async function installRequest(request, root, autoApprove) {
  if (request.action === 'self') return await selfUpdate(autoApprove);
  const plan = planPackageInstall({ packageName: request.packageName, ecosystem: request.ecosystem, workspaceRoot: root });
  stdout.write('Installation plan\n');
  stdout.write('  Package: ' + plan.packageName + '\n');
  stdout.write('  Manager: ' + plan.ecosystem + '\n');
  stdout.write('  Command: ' + plan.command + ' ' + plan.args.map((arg) => JSON.stringify(arg)).join(' ') + '\n');
  stdout.write('  Note: ' + plan.note + '\n');
  const result = await executeTool('install_package', request, {
    root, autoApprove, approval: (message) => approve(message, false, autoApprove)
  });
  if (result && result.exitCode === 0) stdout.write('\nInstallation completed. You can verify it with oasis doctor or the tool’s version command.\n');
  else if (result && result.approved === false) stdout.write('\nInstallation cancelled; no package manager was started.\n');
  else if (result && result.exitCode !== undefined) stdout.write('\nInstallation did not complete successfully. Exit code: ' + result.exitCode + '\n');
  else if (result && result.error) stdout.write('\nInstallation error: ' + result.error + '\n');
  else stdout.write('\nInstallation result: ' + JSON.stringify(result) + '\n');
}

async function initWorkspace(root) {
  const target = path.join(root, 'OASIS.md');
  try { await access(target); stdout.write('OASIS.md already exists; leaving it unchanged.\n'); return; } catch {}
  await writeFile(target, [
    '# Oasis workspace instructions',
    '',
    '## Project purpose',
    'Describe what this repository is for and its main constraints.',
    '',
    '## Development workflow',
    '- Inspect existing code before changing it.',
    '- Prefer small, testable changes.',
    '- Run relevant checks before reporting completion.',
    '- Do not commit credentials or generated user data.',
    '- Ask before destructive commands, remote publishing, or production changes.',
    ''
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  stdout.write('Created ' + target + '. Edit it to give Oasis persistent project context.\n');
}

async function listSkills(root) {
  const skills = await listAvailableSkills(root);
  stdout.write('Agent skills visible to Oasis (skill instructions are context, not executable code):\n');
  if (!skills.length) { stdout.write('  No skills found. Try "oasis skills find frontend" or install one with "oasis skills add SOURCE --skill NAME".\n'); return; }
  const sourceLabels = {
    'built-in': 'bundled',
    workspace: '.oasis/skills',
    'portable-workspace': '.agents/skills',
    'parent-portable': '.agents/skills above the workspace',
    'global-portable': 'global universal skills',
    'claude-project': '.claude/skills',
    'claude-user': '~/.claude/skills',
    'global-extension': 'global extension',
    'project-extension': 'project extension'
  };
  for (const skill of skills) {
    stdout.write('  ' + skill.name + ' [' + (skill.origin || sourceLabels[skill.source] || skill.source) + '] — ' + skill.description + '\n');
  }
}

// Search GitHub for repositories that publish SKILL.md packages.
async function findSkillRepositories(query) {
  const terms = String(query || '').trim();
  const q = encodeURIComponent((terms ? terms + ' ' : '') + 'SKILL.md in:readme,description,name') + '+topic:agent-skills';
  const tries = [
    'https://api.github.com/search/repositories?per_page=15&sort=stars&q=' + q,
    'https://api.github.com/search/repositories?per_page=15&sort=stars&q=' + encodeURIComponent((terms || 'skills') + ' agent skills SKILL.md')
  ];
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'oasis-cli' };
  if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  for (const url of tries) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('GitHub search failed (' + response.status + '). Set GITHUB_TOKEN if you hit the anonymous rate limit.');
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length) return items;
  }
  return [];
}

async function skillsFromSource(root, source, options, autoApprove) {
  const { installSkillsFromSource } = await import('./skill-install.mjs');
  if (!options.list) {
    const ok = autoApprove || await approve('Download "' + source + '" and copy ' + (options.all ? 'all of its skills' : 'the skill "' + options.skill + '"') + ' into ' + options.targetDir + '? Nothing from the source is run; the instructions are treated as untrusted context.', true, false);
    if (!ok) { stdout.write('Skill installation cancelled.\n'); return; }
  }
  const result = await installSkillsFromSource(source, { ...options, env: process.env });
  if (options.list) {
    if (!result.available.length) { stdout.write('No SKILL.md packages found in ' + source + '.\n'); return result; }
    stdout.write('Skills in ' + source + ':\n');
    for (const item of result.available) stdout.write('  ' + item.name + (item.description ? ' — ' + item.description : '') + '\n');
    stdout.write('Install one with: oasis skills add ' + source + ' --skill NAME\n');
    return result;
  }
  stdout.write(result.message + '\n');
  for (const item of result.installed) if (item.skipped.length) stdout.write('  skipped in ' + item.name + ': ' + item.skipped.join(', ') + '\n');
  if (!result.installed.length) process.exitCode = 1;
  return { ok: result.installed.length > 0, ...result };
}

async function installSkill(root, name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name || '')) throw new Error('Skill name must use lowercase letters, numbers, and hyphens. Usage: oasis skills install NAME');
  const source = path.join(APP_ROOT, 'skills', name, 'SKILL.md');
  const destination = path.join(root, '.oasis', 'skills', name, 'SKILL.md');
  try { await access(source); } catch { throw new Error('No bundled skill named "' + name + '". Use oasis skills list.'); }
  try { await access(destination); stdout.write('Skill already exists at ' + destination + '; leaving it unchanged.\n'); return; } catch {}
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, 0);
  stdout.write('Installed skill "' + name + '" into ' + destination + '. It will be loaded as project context in the next agent session.\n');
}

async function manageSkills(root, args, autoApprove) {
  const action = String(args[0] || 'list').toLowerCase();
  const rest = args.slice(1);
  if (action === 'list' || action === 'ls') return await listSkills(root);
  if (action === 'install') return await installSkill(root, rest[0]);
  if (action === 'find' || action === 'search') {
    if (rest.length > 4) throw new Error('Use "oasis skills find [a few keywords]" to search the skills directory.');
    if (rest.some((value) => /^--/.test(value))) throw new Error('Search terms cannot start with command flags.');
    const query = rest.join(' ').trim();
    const items = await findSkillRepositories(query);
    if (!items.length) { stdout.write('No skill repositories found' + (query ? ' for "' + query + '"' : '') + '.\n'); return; }
    for (const item of items) stdout.write('  ' + item.full_name + '  ★' + item.stargazers_count + (item.description ? '  ' + String(item.description).slice(0, 100) : '') + '\n');
    stdout.write('Review one with: oasis skills inspect OWNER/REPO\n');
    return;
  }
  if (action === 'inspect') {
    if (rest.length !== 1) throw new Error('Usage: oasis skills inspect SOURCE');
    return await skillsFromSource(root, rest[0], { list: true }, autoApprove);
  }
  if (action === 'add') {
    if (rest.length < 1) throw new Error('Usage: oasis skills add SOURCE --skill NAME, or oasis skills add SOURCE --all.');
    const source = rest[0];
    let skillName = '';
    let allSkills = false;
    let global = false;
    for (let i = 1; i < rest.length; i++) {
      const value = rest[i];
      if (value === '--skill') {
        if (!rest[i + 1]) throw new Error('--skill requires the exact skill name to install.');
        skillName = rest[++i];
      } else if (value.startsWith('--skill=')) {
        skillName = value.slice('--skill='.length);
      } else if (value === '--all') {
        allSkills = true;
      } else if (value === '--global' || value === '-g') {
        global = true;
      } else {
        throw new Error('Usage: oasis skills add SOURCE --skill NAME [--global], or oasis skills add SOURCE --all [--global].');
      }
    }
    if (Boolean(skillName) === allSkills) throw new Error('Choose exactly one of --skill NAME or --all. Use "oasis skills inspect SOURCE" to review available names first.');
    if (skillName && (skillName.length > 128 || /[\r\n\0"]/.test(skillName) || /^-/.test(skillName))) {
      throw new Error('Skill names must be 1–128 characters and cannot contain quotes, line breaks, NUL, or start with a flag.');
    }
    const { getUniversalGlobalSkillsDirectory } = await import('./tools.mjs');
    const targetDir = global ? getUniversalGlobalSkillsDirectory(process.env) : path.join(root, '.agents', 'skills');
    const result = await skillsFromSource(root, source, { skill: skillName, all: allSkills, targetDir }, autoApprove);
    return result;
  }
  throw new Error('Unknown skills action. Use oasis skills list, find, inspect, add, or install.');
}



async function showBackups(root) {
  const backups = await listBackups(root);
  if (!backups.length) { stdout.write('No Oasis snapshots are stored for this workspace yet.\n'); return; }
  stdout.write('Snapshots for ' + path.resolve(root) + ':\n');
  for (const item of backups) stdout.write('  ' + item.id + '  ' + item.relativePath + '  (' + item.reason + ', ' + item.createdAt + ')\n');
}

async function restoreOne(root, backupId) {
  if (!backupId) throw new Error('Usage: oasis restore BACKUP_ID');
  const ok = await approve('Restore snapshot ' + backupId + ' into this workspace? If the target currently exists, Oasis will snapshot it first.', true, false);
  if (!ok) { stdout.write('Restore cancelled.\n'); return; }
  const result = await restoreBackup(root, backupId);
  stdout.write('Restored ' + result.path + ' from snapshot ' + result.restoredFrom + '.\n');
}

function printConfig(config) {
  const summary = getProviderSummary(config);
  stdout.write('Oasis provider configuration\n');
  stdout.write('  Base URL: ' + config.baseURL + '\n');
  stdout.write('  Protocol: ' + (config.protocol || 'openai-compatible') + '\n');
  stdout.write('  Model: ' + config.model + '\n');
  stdout.write('  Authentication: ' + summary.authentication + '\n');
  stdout.write('  API key: ' + (config.apiKey ? 'configured (masked)' : 'not set') + '\n');
  stdout.write('  Config file: ' + config.configPath + '\n');
}

async function waitForBackgroundRegistration() {
  const id = process.env.OASIS_BACKGROUND_ID;
  const runId = process.env.OASIS_BACKGROUND_RUN_ID;
  if (!id || !runId) return;
  const { readEntry } = await import('./background-sessions.mjs');
  for (let i = 0; i < 300; i++) {
    try {
      const entry = await readEntry(id, process.env);
      if (entry.pid === process.pid && entry.runId === runId) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the parent process to register this background run. No task was started.');
}

// What a retried model response was, in plain words: a dropped or stalled
// stream, or a tool call the model sent in a form that could not be parsed.
export function streamRestartNotice(info = {}, partialShown = false) {
  const count = ' (' + (info.attempt || 1) + '/' + (info.limit || 2) + ')';
  if (info.kind === 'malformed-call') return "[retry] The model's tool call could not be parsed; asking it to send the call again" + count + '.';
  const reason = String(info.reason || '');
  const what = /stalled/i.test(reason) ? 'The model response stalled' : /malformed/i.test(reason) ? "The model's tool call could not be parsed" : Number(info.status) >= 500 || /high demand|overloaded|503|unavailable|internal error/i.test(reason) ? 'The provider broke off the response with a server error' + (Number(info.status) >= 500 ? ' (' + info.status + ')' : '') : 'The model connection dropped mid-response';
  return '[network] ' + what + '; retrying' + count + '.' + (partialShown ? ' The partial reply above is discarded.' : '');
}

// "⎿ Read 3 lines" -> "⎿ add.mjs · Read 3 lines" for a result printed away
// from its header (parallel tool calls).
export function labelToolResult(summary, name, call) {
  let args = {};
  try { args = JSON.parse(call && call.function && call.function.arguments || '{}') || {}; } catch {}
  const raw = args.path || args.file_path || args.filePath || args.pattern || args.query || args.command || args.url || '';
  const label = String(Array.isArray(raw) ? raw.join(' ') : raw).replace(/\s+/g, ' ').trim();
  const short = label.length > 40 ? label.slice(0, 39) + '…' : label;
  if (!short) return summary;
  return String(summary).replace('⎿ ', '⎿ ' + short + ' · ');
}


async function runPrompt(prompt, root, autoApprove, session = null, persistence = {}, modeOptions = {}) {
  const requestText = String(prompt || '');
  if (AUTO_HALT && !String(prompt || '').startsWith(WAKE_PREFIX) && !modeOptions.selfPacedLoop) AUTO_HALT = null;
  // The parent starts this process before persisting its PID; wait so a fast
  // background task cannot finish and then be overwritten by the parent's stale
  // initial "running" record.
  await waitForBackgroundRegistration();
  const config = await loadConfig();
  if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
  if (SESSION_OPTIONS.effort) Object.assign(config, applyEffort(config, SESSION_OPTIONS.effort));
  if (modeOptions.model) config.model = modeOptions.model;
  if (modeOptions.effort) Object.assign(config, applyEffort(config, modeOptions.effort));
  try {
    const expanded = await expandFileMentions(root, prompt, { images: visionEnabled(config) });
    if (expanded.files.length) {
      stdout.write('[context] Included ' + expanded.files.map((file) => '@' + file).join(', ') + '\n');
      prompt = expanded.text;
    }
    if (expanded.images && expanded.images.length) {
      modeOptions = { ...modeOptions, images: expanded.images };
      if (stdout.isTTY) await import('./inline-image.mjs').then(({ writeInlineImages }) => writeInlineImages(expanded.images, { stream: stdout, maxRows: 10 })).catch(() => {});
    }
  } catch {}
  if (!config.configured) {
    stdout.write('Oasis needs a model provider for general coding tasks. Run oasis setup first, or configure OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL, and the matching API-key environment variable. Local Ollama-style endpoints can use a loopback URL without an API key.\n');
    return session;
  }
  if (!session) {
    let restored = null;
    if (persistence.resumeId) {
      restored = await loadSession(root, persistence.resumeId);
      if (SESSION_OPTIONS.forkSession) { stdout.write('[session] Forking ' + restored.id + ' into a new session.\n'); restored = { ...restored, id: null }; }
      if (persistence.recapShown !== restored.id) stdout.write('[session] Resuming ' + restored.id + ' (' + restored.messages.length + ' saved messages, last updated ' + restored.updatedAt + ').\n');
      persistence.recapShown = null;
      const goalNote = pausedGoalNotice(restored.goal);
      if (goalNote) stdout.write(goalNote);
      if (restored.turnInProgress) stdout.write('[session] The last turn stopped before it finished; Oasis will ask the model to check the files before continuing.\n');
    }
    session = await createSession({ root, config, restore: restored, ...sessionCreateOptions(), watchFiles: true });
    if (restored) {
      let price = null;
      try { price = priceFor(session.config && session.config.model || config.model, { config: session.config || config }); } catch {}
      const note = resumeCostNotice({ tokens: estimateTokens(session.messages), updatedAt: restored.updatedAt, price });
      if (note) stdout.write(note);
    }
  } else if (path.resolve(session.worktreeSession ? session.worktreeSession.originalRoot : session.root) !== path.resolve(root)) {
    closeSession(session);
    session = await createSession({ root, config, ...sessionCreateOptions(), watchFiles: true });
  }
  if (modeOptions.selfPacedLoop !== undefined) session.selfPacedLoop = modeOptions.selfPacedLoop;
  // MCP servers can ask the user for input mid-call (elicitation); answer in the terminal.
  if (stdin.isTTY && stdout.isTTY && !session.elicit) {
    session.elicit = async (request) => {
      const { askElicitationInTerminal } = await import('./mcp-client-features.mjs');
      const { openInBrowser } = await import('./mcp-oauth.mjs');
      endStream();
      return await askElicitationInTerminal(request, { ask: (question) => askLine(question), write: (text) => stdout.write(text), openUrl: (url) => openInBrowser(url) });
    };
  }
  // watchPaths returned by a CwdChanged hook carry over to the session for the new directory.
  if (persistence.watchPaths) {
    const { startHookWatchers } = await import('./file-watch.mjs');
    const { hookOptions: hookOpts, reloadSessionSettings } = await import('./agent.mjs');
    if (session.fileWatchers) session.fileWatchers.setDynamicPaths(persistence.watchPaths);
    else { session.hookWatchPaths = persistence.watchPaths; try { session.fileWatchers = startHookWatchers(session, { liveReload: true, hookOptions: () => hookOpts(session), reload: reloadSessionSettings }); } catch {} }
    persistence.watchPaths = null;
  }
  session.config = carryLearnedContextWindow(session.config, config);
  // Background agents can finish after this turn; their requests still count in /cost.
  session.onBackgroundUsage = (usage) => recordUsage(USAGE, usage);
  // Auto-connect to the IDE when launched from a VS Code (or fork) integrated terminal.
  if (!session.ideChecked) {
    session.ideChecked = true;
    if (process.env.OASIS_IDE_PORT || process.env.TERM_PROGRAM === 'vscode' || process.env.OASIS_IDE === 'auto') {
      try {
        const { discoverIde, attachIde } = await import('./ide.mjs');
        const client = await discoverIde(root, process.env);
        if (client) { attachIde(session, client); stdout.write('[ide] Connected to ' + client.ideName + ' — selections are shared and edits open as diffs there.\n'); }
      } catch {}
    }
  }
  if (session.ide) ideSession = session;
  if (session.ide) {
    try {
      const { ideSelectionContext } = await import('./ide.mjs');
      const selection = await ideSelectionContext(session);
      if (selection) { stdout.write('[ide] ' + selection.label + '\n'); prompt = selection.text + '\n\n' + prompt; }
    } catch {}
  }
  if (!session.onAgentNotice) session.onAgentNotice = (text) => stdout.write('\n[agents] ' + String(text).split('\n')[0] + ' The report will be shared with Oasis on your next message (/tasks to read it now).\n');
  reportSessionNotices(session);
  if (session.mcpFailures && session.mcpFailures.length) {
    // Print each failure once, but keep it so /mcp can show it and /mcp reconnect can retry it.
    for (const failure of session.mcpFailures) {
      if (failure.reported) continue;
      Object.defineProperty(failure, 'reported', { value: true, enumerable: false, configurable: true });
      stdout.write('[MCP] ' + failure.name + ' did not start: ' + failure.error + (failure.config ? ' (retry with /mcp reconnect ' + failure.name + ')' : '') + '\n');
    }
  }
  // Ctrl+C stops the current task and returns to the prompt; a second Ctrl+C exits.
  const controller = new AbortController();
  const onInterrupt = (kind) => {
    if (controller.signal.aborted && kind === 'escape') return;
    if (controller.signal.aborted) { stdout.write('\nExiting Oasis.\n'); closeSession(session); exitAfterTelemetry(130); }
    endStream();
    stdout.write('\n' + interruptNotice(kind, colorEnabled(stdout)) + '\n');
    controller.abort();
  };
  if (stdin.isTTY) process.on('SIGINT', onInterrupt);
  const turnStartedAt = Date.now();
  CURRENT_TURN_STARTED_AT = turnStartedAt;
  CURRENT_TURN_WAITED_MS = 0;
  terminalProgress().set('busy');
  let turnFailed = false;
  if (session && session.settings) configureSounds({ enabled: typeof session.settings.sounds === 'boolean' ? session.settings.sounds : undefined, volume: session.settings.soundVolume });
  let lastToolHeader = null;
  let todosDone = completedTodoCount(session && session.todos);
  rateLimitWaitsThisTurn = 0;
  turnKeys = startTurnKeys(onInterrupt, (text) => !controller.signal.aborted && !modeOptions.fork && steerSession(session, text));
  try {
    const fork = modeOptions.fork;
    const runner = fork ? (s, p, o) => runForkedTurn(s, p, { ...o, agent: fork.agent, label: fork.label, env: process.env }) : modeOptions.planOnly ? runAgentPlan : runAgentTurn;
    // allowed-tools from a command apply only while it runs.
    const granted = session.permissions && Array.isArray(modeOptions.grantTools) ? session.permissions.sessionAllow.length : -1;
    if (granted >= 0) for (const rule of modeOptions.grantTools) session.permissions.rememberForSession(rule);
    if (fork) stdout.write('[fork] Running ' + fork.label + ' in a ' + (fork.agent || 'general-purpose') + ' subagent.\n');
    const result = await runner(session, prompt, {
      signal: controller.signal,
      autoApprove,
      ...(modeOptions.images ? { images: modeOptions.images } : {}),
      ...(modeOptions.expansion ? { expansion: modeOptions.expansion } : {}),
      onThinkingBudget: (budget) => stdout.write('[thinking] Extended thinking on for this task (budget ' + budget + ' tokens).\n'),
      onReasoningEffort: (effort) => stdout.write('[thinking] Reasoning effort ' + effort + ' for this task.\n'),
      onMemoryRecall: (ids) => stdout.write('[memory] Recalled ' + ids.join(', ') + '\n'),
      onSteer: (info) => { endStream(); stdout.write((colorEnabled(stdout) ? '\x1b[2m' : '') + '  ↳ Oasis read your ' + (info.delivered === 1 ? 'message' : info.delivered + ' messages') + ' and is adjusting' + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n'); },
      ...(stdout.isTTY ? { onModelWait } : {}),
      onProviderRetry: (event) => { stopWaitIndicator(); const dim = colorEnabled(process.stderr); process.stderr.write((dim ? '\x1b[2m' : '') + '  ⎿ Provider ' + (event.status ? 'error ' + event.status : 'connection failed') + (event.reason && event.status ? ' (' + event.reason + ')' : '') + ' · retrying in ' + formatWait(event.waitMs) + ' (' + event.attempt + '/' + event.limit + ')' + (dim ? '\x1b[22m' : '') + '\n'); },
      onRateLimitWait: (event) => onRateLimitWait(event),
      approval: (message, forceInteractive = false, meta = {}) => approve(message, forceInteractive, autoApprove, meta),
      ...(stdin.isTTY && stdout.isTTY ? { askUser: (question) => { endStream(); return askQuestionInTerminal(question); } } : {}),
      ...(stdin.isTTY && stdout.isTTY ? { connectorCard: async (flow) => {
        endStream();
        playSound('attention', { stream: stdout });
        const { connectInTerminal } = await import('./connectors.mjs');
        const { openInBrowser } = await import('./mcp-oauth.mjs');
        return await connectInTerminal(flow, { write: (text) => stdout.write(text), askLine: (question) => askLine(question), askSecret: (question) => askSecret(question), open: (url) => openInBrowser(url), width: stdout.columns || 80 });
      } } : {}),
      onToolStart: (event) => {
        if (richOutput() && !verboseEnabled(session) && event && !event.subagent && EXPLORE_TOOLS.has(event.name)) { holdExploration(event); return; }
        endStream(); lastToolHeader = event && event.call ? event.call.id : null; stdout.write('\n' + (richOutput() ? describeTool(event, { color: true }) : describeToolStart(event)) + '\n'); },
      onAutoMode: (event) => { endStream(); stdout.write('[auto] ' + (event.decision === 'allow' ? 'Allowed' : event.decision === 'block' ? 'Blocked' : 'Asking you about') + ' ' + event.tool + (event.reason ? ': ' + event.reason : '') + '\n'); },
      onUsage: (usage) => recordUsage(USAGE, usage),
      onVerificationGate: (gate) => { endStream(); const dim = colorEnabled(stdout); stdout.write((dim ? '\x1b[2m' : '') + '  ⎿ Not finished yet: ' + gate.steps.join(', ') + (dim ? '\x1b[22m' : '') + '\n'); },
      onThrash: (info) => { endStream(); stdout.write('[stuck?] `' + info.command + '` has failed the same way after ' + info.count + ' rounds of edits; Oasis asked the model to step back and diagnose before editing again.\n'); },
      onStreamRestart: (info) => { const ended = endStream(); stdout.write(streamRestartNotice(info, typeof info.partialShown === 'boolean' ? info.partialShown : ended) + '\n'); },
      onContextOverflow: (info) => { endStream(); stdout.write(info.smallContextTools ? '\n[context] ' + (info.contextWindow ? 'The model server has a ' + info.contextWindow + '-token window' : 'The provider said the first request was too large') + '; switched to the small-context tool set (others stay reachable through tool_search) and retrying.\n' : '\n[context] The provider said the request was too long for the context window; compacted (' + Math.round(info.beforeChars / 1000) + 'k → ' + Math.round(info.afterChars / 1000) + 'k chars) and retrying.\n'); },
      onCompactionStart: (info) => { endStream(); stdout.write('\n[context] Compacting ' + info.messages + ' older messages (about ' + Number(info.beforeTokens || 0).toLocaleString('en-US') + ' tokens; local fallback after ' + info.timeoutSeconds + 's)…\n'); },
      onCompaction: (info) => stdout.write('\n[context] ' + String(info.note || 'Compacted older conversation history.') + (info.notesSaved ? ' Continuity note saved in .oasis/session-notes.md.' : ' Continuity note was not saved.') + '\n'),
      // MessageDisplay hooks see whole messages, so streaming is off while any are configured.
      ...(stdout.isTTY && process.env.OASIS_NO_STREAM !== '1' && !hasConfiguredHooks(session.hooks || {}, 'MessageDisplay') ? { onDelta: streamDelta } : {}),
      // A running command keeps a live status line: what runs, for how long,
      // and its latest output line, so a long build never looks frozen.
      ...(stdout.isTTY ? { onToolOutput: (event) => liveToolStatus(event) } : {}),
      onToolResult: ({ name, result, call }) => {
        stopToolStatus(call);
        lastToolResult = { name, result };
        if (persistence.enabled) saveMidTurn(session);
        if (exploredResult(call, result)) return;
        if (name === 'todo_write' && result && !result.error) { const done = completedTodoCount(Array.isArray(result.todos) ? result.todos : session.todos); if (done > todosDone) playSound('task', { stream: stdout }); todosDone = done; }
        if (richOutput() && call && ['edit_file', 'multi_edit', 'write_file'].includes(name)) {
          let args = {};
          try { args = JSON.parse(call.function && call.function.arguments || '{}'); } catch {}
          // The file after the edit, so the diff shows whole lines with numbers.
          let fileText = null;
          if (name !== 'write_file' && result && !result.error) {
            try { const file = path.resolve(root, String(result.path || args.path || '')); if (statSync(file).size <= 2 * 1024 * 1024) fileText = readFileSync(file, 'utf8'); } catch { fileText = null; }
          }
          const shown = describeEdit({ name, args, result }, { color: true, fileText });
          if (shown) stdout.write(shown + '\n');
        }
        let summary = richOutput() && !verboseEnabled(session) ? describeToolResult(name, result, { color: true }) : '';
        // Parallel calls print every header first; name the call on each result
        // that does not sit right under its own header.
        if (summary && call && lastToolHeader && call.id !== lastToolHeader) summary = labelToolResult(summary, name, call);
        if (summary) stdout.write(summary + '\n');
        else if (result && (result.error || result.exitCode !== undefined && result.exitCode !== 0)) {
          stdout.write('[tool result] ' + name + ': ' + String(result.error || ('exit code ' + result.exitCode)).slice(0, 700) + '\n');
        }
        if (summary) lastToolHeader = '#result'; // a later result in the batch is away from its header too
        // Screenshots and image files the agent looked at, drawn inline where the terminal can.
        if (result && result.imageData && richOutput()) import('./inline-image.mjs').then(({ writeInlineImages }) => writeInlineImages([result.imageData], { stream: stdout })).catch(() => {});
        if (name === 'auto_test' && result && result.passed) stdout.write('[auto-test] passed in ' + (Math.round(result.durationMs / 100) / 10) + 's\n');
        if (name === 'report_findings' && result && !result.error) { endStream(); stdout.write('\n[findings]\n' + formatFindings(session.reportedFindings, { color: colorEnabled(stdout) }) + '\n'); }
        if (verboseEnabled(session)) { const shown = verboseToolOutput(name, result, { color: colorEnabled(stdout) }); if (shown) stdout.write(shown + '\n'); }
      },
      onText: (text) => {
        // The final text can extend what was streamed (the live stream is
        // bounded); show the rest instead of dropping it.
        const full = String(text || '');
        if (streamedSoFar && streamedSoFar !== ' ' && full.length > streamedSoFar.length && full.startsWith(streamedSoFar)) streamDelta(full);
        if (endStream()) return;
        if (richOutput()) { const md = new MarkdownStream({ write: (chunk) => stdout.write(chunk), color: true, columns: () => stdout.columns || 80, prefix: '\x1b[38;2;251;191;36m●\x1b[39m ' }); md.push(String(text)); md.end(); }
        else stdout.write('\nOasis> ' + text + '\n');
      }
    }).finally(() => { flushExploration(); if (granted >= 0) session.permissions.sessionAllow.length = granted; });
    USAGE.turns += 1;
    if (result.modelRouting && result.modelRouting.enabled) {
      const taskUsage = result.taskUsage || {};
      if (result.modelRouting.tier === 'easy' || result.modelRouting.tier === 'work') {
        USAGE.routingTasks = Number(USAGE.routingTasks || 0) + 1;
        if (typeof taskUsage.savingsUSD === 'number') USAGE.routingSavingsUSD = Number(USAGE.routingSavingsUSD || 0) + taskUsage.savingsUSD;
      }
      const costText = typeof taskUsage.costUSD === 'number' ? formatUsd(taskUsage.costUSD) : 'unknown';
      const baselineText = typeof taskUsage.strongModelCostUSD === 'number' ? formatUsd(taskUsage.strongModelCostUSD) : 'unknown';
      const savingsText = typeof taskUsage.savingsUSD === 'number'
        ? (taskUsage.savingsUSD >= 0 ? 'saved ' : 'cost ' + formatUsd(Math.abs(taskUsage.savingsUSD)) + ' more than ') + (taskUsage.savingsUSD >= 0 ? formatUsd(taskUsage.savingsUSD) : 'the strong-model estimate')
        : 'savings unavailable (pricing not configured for both models)';
      stdout.write('[routing] ' + result.modelRouting.tier + ' · ' + result.modelRouting.selectedModel +
        ' · ' + taskUsage.totalTokens + ' tokens · ' + costText + ' vs strong-model estimate ' + baselineText +
        ' · ' + savingsText + '\n');
      const escalated = result.modelRouting.escalation;
      if (escalated) stdout.write('[routing] escalated at step ' + escalated.step + ' from ' + escalated.from + ' to ' + escalated.to + ': ' + escalated.reason + '\n');
      else if (result.modelRouting.escalationSkipped) stdout.write('[routing] no escalation available: ' + result.modelRouting.escalationSkipped + '\n');
    }
    if (result.verification && result.verification.required) {
      const evidence = result.verification;
      const check = evidence.checkRequired
        ? (evidence.lastCheck
          ? checkKindLabel(evidence.lastCheck) +
            (Number.isInteger(evidence.lastCheck.exitCode) ? ' (exit ' + evidence.lastCheck.exitCode + ')' : '')
          : 'not recorded')
        : 'not required';
      const lsp = Array.isArray(evidence.lsp) ? evidence.lsp : [];
      const lspIssues = lsp.filter((item) => item.status === 'issues' || item.status === 'errors' || (item.status === 'unavailable' && item.blocking !== false)).length;
      const lspSkipped = lsp.filter((item) => item.status === 'unavailable' && item.blocking === false).length;
      const lspStatus = lsp.length && lspSkipped === lsp.length
        ? 'LSP skipped (no language server installed for ' + (lsp.length === 1 ? 'this file' : 'these ' + lsp.length + ' files') + ')'
        : lsp.length
        ? 'LSP ' + lspIssues + ' issue(s) across ' + lsp.length + ' changed file(s)' + (lspSkipped ? ' (' + lspSkipped + ' skipped: no language server installed)' : '')
        : 'LSP not reported';
      const verificationLine = (evidence.complete ? 'Complete' : 'Incomplete') +
        ' · diff ' + (evidence.diffReviewed ? 'reviewed' : 'not reviewed') +
        ' · check ' + check + ' · ' + lspStatus +
        (evidence.autoTest ? ' · auto-test ' + (evidence.autoTest.passed ? 'passed' : 'failed') + ' (' + evidence.autoTest.attempts + ' run' + (evidence.autoTest.attempts === 1 ? '' : 's') + ')' : '');
      if (richOutput()) {
        // One plain line: what was checked, or what still is not. The full
        // evidence stays in the plain output, -p JSON and /status.
        const issues = Array.isArray(evidence.issues) ? evidence.issues : [];
        const facts = [
          evidence.lastCheck ? checkKindLabel(evidence.lastCheck) : '',
          evidence.autoTest ? 'auto-test ' + (evidence.autoTest.passed ? 'passed' : 'failed') : '',
          lspIssues ? lspIssues + ' editor diagnostic' + (lspIssues === 1 ? '' : 's') : ''
        ].filter(Boolean);
        const text = evidence.complete
          ? '\x1b[32m✓ Checked\x1b[39m' + (facts.length ? '\x1b[2m · ' + facts.join(' · ') + '\x1b[22m' : '')
          : '\x1b[33m! Not fully checked\x1b[39m\x1b[2m' + (issues.length ? ': ' + issues.join('; ') : facts.length ? ' · ' + facts.join(' · ') : '') + '\x1b[22m';
        stdout.write('\n' + wrapRendered('  ' + text, stdout.columns || 80, { indent: 4 }) + '\n');
      } else stdout.write('[verification] ' + verificationLine + '\n');
      if (!richOutput() && !evidence.complete && Array.isArray(evidence.issues) && evidence.issues.length) {
        stdout.write('[verification] Blockers: ' + evidence.issues.join('; ') + '. Do not treat the task as fully verified yet.\n');
      }
    } else if (result.verificationIncomplete && Array.isArray(result.verificationIssues) && result.verificationIssues.length) {
      stdout.write('[verification] Incomplete: ' + result.verificationIssues.join('; ') + '. Do not treat the task as fully verified yet.\n');
    } else if (!result.finished) {
      stdout.write('Oasis reached a safety limit before the task was fully completed. Review the summary and continue in a new turn if appropriate.\n');
    }
    const changedThisTurn = result.verification && Array.isArray(result.verification.changedPaths) ? result.verification.changedPaths : [];
    if (changedThisTurn.length) {
      const { autoCommitEnabled, autoCommitTurn, describeAutoCommit } = await import('./auto-commit.mjs');
      if (autoCommitEnabled(session, process.env)) {
        const line = describeAutoCommit(await autoCommitTurn({ root: session.root || root, paths: changedThisTurn, prompt: requestText }).catch((error) => ({ error: error.message })));
        if (line) stdout.write((richOutput() ? '\x1b[2m  ' + line + '\x1b[22m' : '[auto-commit] ' + line) + '\n');
      }
    }
    if (richOutput()) stdout.write('\x1b[2m  ' + formatTurnSummary({ ms: Math.max(0, Date.now() - turnStartedAt - CURRENT_TURN_WAITED_MS), toolCalls: result.toolCalls, tokens: result.tokensUsed, finished: result.finished !== false || Boolean(result.verificationIncomplete && result.text) }) + '\x1b[22m\n');
    const doneSound = Date.now() - turnStartedAt >= DONE_SOUND_AFTER_MS && playSound('done', { stream: stdout });
    notifyAttention('OASIS · ' + formatTurnSummary({ ms: Date.now() - turnStartedAt, toolCalls: result.toolCalls, tokens: result.tokensUsed, finished: result.finished !== false || Boolean(result.verificationIncomplete && result.text) }), { elapsedMs: Date.now() - turnStartedAt, soundPlayed: doneSound, stream: stdout });
  } catch (error) {
    endStream();
    if (controller.signal.aborted || error.name === 'AbortError') {
      repairInterruptedHistory(session);
      let changed = [];
      try { const { listCheckpoints } = await import('./checkpoints.mjs'); const latest = listCheckpoints(session)[0]; changed = latest && latest.files || []; } catch {}
      if (changed.length) stdout.write('  ⎿ ' + (changed.length === 1 ? changed[0] + ' was' : changed.length + ' files were') + ' changed before you stopped; /rewind 1 undoes ' + (changed.length === 1 ? 'it' : 'them') + '.\n');
    } else {
      const message = 'OASIS error: ' + (error.message || String(error));
      stdout.write('\n' + (stdout.isTTY && stdout.columns ? wrapCommandOutput(message, stdout.columns) : message) + '\n');
      turnFailed = true;
      playSound('error', { stream: stdout });
      haltAutoContinue(error);
    }
  } finally {
    stopWaitIndicator();
    terminalProgress().set(turnFailed ? 'error' : 'clear');
    process.removeListener('SIGINT', onInterrupt);
    if (turnKeys) { turnKeys.stop(); turnKeys = null; }
    // Steering that arrived too late for this turn (or after Esc) is never lost:
    // it becomes the next message.
    const undelivered = takeSteering(session);
    if (undelivered.length) {
      QUEUED_INPUT.unshift(...undelivered);
      stdout.write('[queued] ' + undelivered.length + ' message' + (undelivered.length === 1 ? '' : 's') + ' sent during the turn will run next.\n');
    }
  }
  reportSessionNotices(session);
  if (persistence.enabled) {
    try {
      await settleMidTurnSave(session);
      const saved = await saveSession(session);
      if (!session.announcedSave || session.announcedSave !== saved.id) {
        session.announcedSave = saved.id;
        if (process.env.OASIS_QUIET_SESSIONS === '1') {}
        else if (richOutput()) stdout.write('\x1b[2m  Chat saved · continue later with oasis -c\x1b[22m\n');
        else stdout.write((colorEnabled(stdout) ? '\x1b[2m' : '') + '[session] Saved as ' + saved.id.slice(0, 8) + ' · resume with oasis -c or oasis -r ' + saved.id + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n');
      }
    } catch (error) {
      stdout.write('[session] Could not save history: ' + error.message + '\n');
    }
  }
  return session;
}

async function streamInputChannel() {
  const { createStreamJsonChannel } = await import('./headless.mjs');
  const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  return createStreamJsonChannel(lines, (event) => stdout.write(JSON.stringify(event) + '\n'));
}

async function readPipedStdin(options = {}) {
  // Only read stdin when it is a pipe, socket, or redirected file (not a terminal or
  // /dev/null). Use `< /dev/null` if a job inherits an open stdin it never closes.
  let info;
  try { info = fstatSync(0); } catch { return ''; }
  if (stdin.isTTY || !(info.isFIFO() || info.isFile() || info.isSocket())) return '';
  // With a prompt already on the command line, an inherited pipe that never sends
  // anything (CI runners, IDE tasks, `nohup`) used to hang `oasis -p` silently forever.
  // Wait a few seconds for the first byte, then go on without stdin.
  const firstByteMs = info.isFile() ? 0 : Number(options.firstByteMs || 0);
  let data = '';
  const iterator = stdin[Symbol.asyncIterator]();
  try {
    let first = true;
    while (true) {
      let timer = null;
      const next = iterator.next();
      const step = first && firstByteMs > 0
        ? await Promise.race([next, new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), firstByteMs); })])
        : await next;
      if (timer) clearTimeout(timer);
      if (step.timeout) {
        process.stderr.write('[oasis] stdin is open but sent nothing for ' + Math.round(firstByteMs / 1000) + 's; continuing with the prompt only (redirect `< /dev/null` to skip the wait).\n');
        try { stdin.pause(); stdin.unref?.(); } catch {}
        return '';
      }
      first = false;
      if (step.done) break;
      data += step.value;
      if (data.length > 1024 * 1024) break;
    }
  } finally {
    if (data.length > 1024 * 1024) { try { await iterator.return?.(); } catch {} }
  }
  return data.slice(0, 1024 * 1024);
}

// Codex `--config key=value` for `oasis exec`: the keys the Codex SDK sets map to
// OASIS options; anything else is reported on stderr and ignored.
function applyCodexConfig(pair, headless, { parseCodexConfigValue, codexEffort }) {
  const key = pair.slice(0, pair.indexOf('=')).trim();
  const value = parseCodexConfigValue(pair.slice(pair.indexOf('=') + 1));
  if (key === 'model') { SESSION_OPTIONS.model = String(value); return; }
  if (key === 'model_reasoning_effort') { const level = codexEffort(value); if (level) SESSION_OPTIONS.effort = level; return; }
  if (key === 'approval_policy') {
    headless.codexApproval = String(value);
    if (value === 'never') SESSION_OPTIONS.permissionMode = SESSION_OPTIONS.permissionMode === 'plan' ? 'plan' : 'auto';
    else SESSION_OPTIONS.permissionMode = SESSION_OPTIONS.permissionMode || 'default';
    return;
  }
  if (key === 'sandbox_mode') {
    headless.codexSandbox = String(value);
    if (value === 'read-only') SESSION_OPTIONS.permissionMode = 'plan';
    else if (value === 'workspace-write') process.env.OASIS_SANDBOX = '1';
    else if (value === 'danger-full-access') process.env.OASIS_SANDBOX = '0';
    return;
  }
  if (key === 'sandbox_workspace_write.network_access') { SESSION_OPTIONS.settingsOverrides.push({ settings: { sandbox: { network: value === true } }, file: '--config' }); return; }
  if (key === 'web_search') { if (value === 'disabled' || value === false) SESSION_OPTIONS.disallowedTools.push('web_search'); return; }
  if (key === 'tools.web_search') { if (value === false) SESSION_OPTIONS.disallowedTools.push('web_search'); return; }
  (headless.ignoredConfig ||= []).push(key);
}

async function printMode(root, headless, args, autoApprove, persistence) {
  const state = { started: false };
  try {
    return await printModeRun(root, headless, args, autoApprove, persistence, state);
  } catch (error) {
    if (state.started) throw error;
    if (headless.codexJson) {
      // Codex exec --json: a parseable error event on stdout, the message on stderr, exit 1.
      stdout.write(JSON.stringify({ type: 'error', message: String(error && error.message || error) }) + '\n');
      stderr.write('OASIS error: ' + String(error && error.message || error) + '\n');
      process.exitCode = 1;
      return;
    }
    const out = headlessSetupErrorOutput(error, headless.outputFormat);
    if (out.stdout) stdout.write(out.stdout);
    stderr.write(out.stderr);
    process.exitCode = 1;
  }
}

async function printModeRun(root, headless, args, autoApprove, persistence, state) {
  let prompt = [headless.prompt, ...args].filter(Boolean).join(' ').trim();
  if (headless.codexConfig && headless.codexConfig.length) {
    const helpers = await import('./codex-exec-json.mjs');
    for (const pair of headless.codexConfig) applyCodexConfig(pair, headless, helpers);
  }
  // Codex danger-full-access + approval never is Codex's "no sandbox, no approvals"
  // (--dangerously-bypass-approvals-and-sandbox): the same as --yolo here. The
  // runtime's hard refusals (home deletion, force pushes, ...) still apply.
  if (headless.codexSandbox === 'danger-full-access' && headless.codexApproval === 'never' && !SESSION_OPTIONS.restricted) {
    SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; autoApprove = true;
  }
  // Codex exec: a prompt of "-" means read it from stdin.
  if (prompt === '-') prompt = '';
  if (headless.ignoredConfig && headless.ignoredConfig.length) stderr.write('[exec] Ignored Codex config key(s) with no OASIS equivalent: ' + headless.ignoredConfig.join(', ') + '\n');
  const streamInput = headless.inputFormat === 'stream-json';
  const stdinWait = Number(process.env.OASIS_STDIN_WAIT_SECONDS);
  const piped = streamInput ? '' : await readPipedStdin({ firstByteMs: prompt ? (Number.isFinite(stdinWait) && stdinWait >= 0 ? stdinWait : 3) * 1000 : 0 });
  if (piped.trim()) prompt = prompt ? prompt + '\n\n<stdin>\n' + piped + '\n</stdin>' : piped;
  const goalCommand = /^\/goal\s+(.+)$/s.exec(prompt.trim());
  if (goalCommand && !/^(pause|resume|clear|edit|status)\b/i.test(goalCommand[1].trim())) {
    // oasis -p "/goal npm test passes" works like --goal.
    if (goalCommand[1].trim().length > 4000) throw new Error('A goal can be at most 4,000 characters. Put the details in a file and point the goal at it.');
    headless.goal = goalCommand[1].trim();
    prompt = '';
  }
  if (headless.goal && !prompt.trim()) prompt = 'Goal: ' + headless.goal + '\nWork toward this goal now. Verify results by running checks, not by assumption. Keep going until it is fully met.';
  if (prompt.trim().startsWith('/')) {
    // oasis -p "/review src" runs a custom command or skill, like the interactive prompt.
    const custom = await resolveCustomCommand(root, prompt.trim(), await customCommandContext(root)).catch(() => null);
    if (custom) {
      for (const item of custom.shell || []) if (item.skipped) stderr.write('[command] Skipped !`' + item.command + '`: ' + item.skipped + '\n');
      prompt = custom.prompt;
      if (custom.command.model && !SESSION_OPTIONS.model) SESSION_OPTIONS.model = custom.command.model;
      if (custom.command.effort && !SESSION_OPTIONS.effort) SESSION_OPTIONS.effort = custom.command.effort;
      // The whole -p run is this command, so its allowed-tools apply to the run.
      if (Array.isArray(custom.grantTools)) SESSION_OPTIONS.allowedTools.push(...custom.grantTools);
    } else {
      const skillCommand = await resolveSkillCommand(root, prompt.trim()).catch(() => null);
      if (skillCommand) prompt = skillCommand.options.fork ? 'Use the task tool with subagent_type "' + (skillCommand.options.fork.agent || 'general-purpose') + '" to run this, then report its result:\n\n' + skillCommand.prompt : skillCommand.prompt;
    }
  }
  if (!prompt.trim() && !streamInput) throw new Error('Usage: oasis -p "your task" [--output-format text|json|stream-json] [--max-turns N] [--goal "condition"] [--model ID]');
  const config = await loadConfig();
  if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
  if (SESSION_OPTIONS.effort) Object.assign(config, applyEffort(config, SESSION_OPTIONS.effort));
  if (!config.configured) {
    const envKeys = providerKeysInEnv();
    if (envKeys.length) throw new Error('No model provider is configured, but ' + envKeys.map((item) => item.name).join(', ') + (envKeys.length > 1 ? ' are' : ' is') + ' set.\n  Run: oasis connect --from-env' + (envKeys.length > 1 ? ' [' + envKeys.map((item) => item.provider).join('|') + ']' : '') + '\n  It finds a model that works with that key and saves it.');
  }
  if (!config.configured) throw new Error('No model provider is configured.\n  Pick one:\n    oasis connect        paste an API key, model link or local server address\n    oasis setup          guided setup in this terminal (API key, free gateway, or Ollama)\n    oasis setup --auto   detect this computer and any local model server, then configure the best fit\n    oasis web --open     set it up in the browser workspace instead\n    OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL + API key variable   for CI and scripts\n  Guide: https://github.com/FAHTHIZ/oasis#install');
  if (SESSION_OPTIONS.channels.length || SESSION_OPTIONS.devChannels.length) stderr.write('[channels] Channels need an interactive session; ignored with -p.\n');
  // CI runners and supervisors stop jobs with SIGTERM. Commands run in their own
  // process group, so without this they would outlive Oasis and the job would
  // exit 0. Abort the turn (which stops running commands), then exit 128+signal.
  const stopController = new AbortController();
  let stopSignal = null;
  let stopSignalAt = 0;
  const SIGNAL_CODES = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  const onStopSignal = (name) => {
    if (stopSignal) {
      // `timeout` and process supervisors deliver SIGTERM to the process and
      // then to its group, so one stop request arrives twice. Only a later
      // signal means "exit now"; an immediate exit would skip the save notice.
      if (Date.now() - stopSignalAt >= 1000) exitAfterTelemetry(128 + SIGNAL_CODES[name]);
      return;
    }
    stopSignal = name;
    stopSignalAt = Date.now();
    stderr.write('[oasis] Received ' + name + '; stopping the task and any running commands.\n');
    // The result says what stopped the run; "cancelled by the user" would be wrong for a CI timeout.
    stopController.abort(Object.assign(new Error('Stopped by ' + name + ' before the task finished.'), { name: 'AbortError', stopSignal: name }));
    setTimeout(() => exitAfterTelemetry(128 + SIGNAL_CODES[name]), 5000).unref();
  };
  const stopHandlers = Object.keys(SIGNAL_CODES).map((name) => [name, () => onStopSignal(name)]);
  for (const [name, handler] of stopHandlers) process.on(name, handler);
  let exitCode;
  try {
  let summary;
  state.started = true;
  let codexStream = null;
  let codexImages = [];
  if (headless.codexJson) {
    const { createCodexExecJsonStream } = await import('./codex-exec-json.mjs');
    // The thread id is known up front (Codex prints thread.started first), so name the session now.
    if (!persistence.resumeId && !SESSION_OPTIONS.sessionId) SESSION_OPTIONS.sessionId = randomUUID();
    codexStream = createCodexExecJsonStream({ write: (text) => stdout.write(text), root, threadId: persistence.resumeId || SESSION_OPTIONS.sessionId });
    if (headless.images && headless.images.length) {
      const { inputToPrompt } = await import('./codex-app-server.mjs');
      const converted = inputToPrompt(headless.images.map((file) => ({ type: 'localImage', path: file })), root);
      codexImages = converted.images;
      if (converted.text) prompt += '\n\n' + converted.text;
    }
  }
  ({ exitCode, summary } = await runHeadless({
    signal: stopController.signal,
    prompt, root, config, autoApprove,
    ...(codexStream ? { onEvent: codexStream.onEvent, onSession: codexStream.onSession, toolObserver: codexStream.toolObserver } : {}),
    ...(codexImages.length ? { images: codexImages } : {}),
    outputFormat: codexStream ? 'none' : headless.outputFormat,
    maxTurns: headless.maxTurns,
    ...(headless.goal ? { goal: headless.goal, goalMaxTurns: headless.goalMaxTurns || 10 } : {}),
    planOnly: headless.planOnly,
    jsonSchema: headless.jsonSchema || null,
    sessionOptions: { ...sessionCreateOptions(), channels: [] },
    persistence: { ...persistence, fork: Boolean(SESSION_OPTIONS.forkSession) },
    env: process.env,
    ...(streamInput ? { inputStream: await streamInputChannel() } : {}),
    includePartial: Boolean(headless.includePartial),
    replayUser: Boolean(headless.replayUser),
    permissionPromptTool: headless.permissionPromptTool || null,
    permissionPrompts: headless.permissionPrompts || null,
    includeHookEvents: Boolean(headless.includeHookEvents),
    forwardSubagentText: Boolean(headless.forwardSubagentText),
    promptSuggestions: Boolean(headless.promptSuggestions),
    requireVerified: Boolean(headless.requireVerified)
  }));
  // Codex's -o/--output-last-message: also write the final reply to a file.
  if (headless.outputLastMessage && summary) {
    const text = summary.structured_output !== undefined ? JSON.stringify(summary.structured_output) : String(summary.result || '');
    await writeFile(path.resolve(headless.outputLastMessage), text + (text.endsWith('\n') ? '' : '\n')).catch((error) => stderr.write('[oasis] Could not write ' + headless.outputLastMessage + ': ' + error.message + '\n'));
  }
  } finally { for (const [name, handler] of stopHandlers) process.removeListener(name, handler); }
  if (stopSignal) exitCode = 128 + SIGNAL_CODES[stopSignal];
  process.exitCode = exitCode;
  if (process.env.OASIS_BACKGROUND_ID) {
    const { finishBackgroundSession } = await import('./background-sessions.mjs');
    await finishBackgroundSession(process.env.OASIS_BACKGROUND_ID, { exitCode }, process.env).catch(() => {});
  }
}

// Setup hooks (--init, --init-only, --maintenance): command hooks only, output discarded.
async function runSetupHooks(root, trigger) {
  const { runHooks, hasHooks } = await import('./hooks.mjs');
  const settings = await loadSettings(root).catch(() => null);
  if (!settings || !hasHooks(settings.hooks, 'Setup')) return;
  const result = await runHooks('Setup', { session_id: 'setup', trigger }, { hooks: settings.hooks, root, env: process.env }).catch(() => null);
  if (result) for (const message of result.messages) stderr.write('[hook] ' + message + '\n');
}

// CwdChanged hooks run when /cd switches the workspace.
async function fireCwdChanged(session, oldRoot, newRoot) {
  const { runHooks, hasHooks } = await import('./hooks.mjs');
  const { hookOptions } = await import('./agent.mjs');
  const hooks = session ? session.hooks : (await loadSettings(oldRoot).catch(() => ({}))).hooks;
  if (!hasHooks(hooks, 'CwdChanged')) return;
  const options = session ? hookOptions(session) : { hooks, root: oldRoot, env: process.env };
  const result = await runHooks('CwdChanged', { session_id: session && session.sessionId || 'unsaved', old_cwd: oldRoot, new_cwd: newRoot }, options).catch(() => null);
  if (result) for (const message of result.messages) stdout.write('[hook] ' + message + '\n');
  return result && Array.isArray(result.watchPaths) ? result.watchPaths.filter((item) => path.isAbsolute(item)) : null;
}

// oasis -w NAME: run the whole session in a fresh git worktree on its own branch.
async function startSessionWorktree(root, name, out) {
  const { createWorktree } = await import('./worktrees.mjs');
  let worktree;
  const settings = await loadSettings(root).catch(() => ({ hooks: {} }));
  const hookOptions = { hooks: settings.hooks || {}, root, env: process.env };
  try { worktree = await createWorktree(root, name, { hookOptions }); }
  catch (error) { throw new Error('--worktree: ' + error.message.replace(/isolation "worktree"/g, '--worktree').replace(/, or launch the subagent without isolation/, '')); }
  worktree.hookOptions = hookOptions;
  out.write('[worktree] Working in ' + worktree.relative + (worktree.hook ? ' (created by a WorktreeCreate hook)' : ' on branch ' + worktree.branch) + '. Your main checkout is untouched.\n');
  if (worktree.setup) out.write('[worktree] ' + (await import('./worktree-setup.mjs')).worktreeSetupSummary(worktree.setup) + '\n');
  return worktree;
}

// oasis -w NAME --tmux: run the worktree session in its own tmux session (a new window when
// already inside tmux, which keeps the worktree for you to clean up).
async function tmuxWorktreeSession(root, name, rawArgs) {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) throw new Error('--tmux needs tmux on PATH.');
  const worktree = await startSessionWorktree(root, name, stdout);
  const inner = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--tmux' || arg === '--tmux=classic') continue;
    if (arg === '-w' || arg === '--worktree') { if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) i++; continue; }
    if (arg === '-C' || arg === '--cwd' || arg === '--cd') { i++; continue; }
    inner.push(arg);
  }
  const command = [process.execPath, fileURLToPath(import.meta.url), '-C', worktree.path, ...inner];
  const label = 'oasis-' + String(name).replace(/[^\w-]/g, '-').slice(0, 40);
  if (process.env.TMUX) {
    spawnSync('tmux', ['new-window', '-n', label, '-c', worktree.path, ...command], { stdio: 'inherit' });
    stdout.write('[tmux] Opened window ' + label + ' in ' + worktree.relative + '. The worktree is kept; remove it with git worktree remove ' + worktree.relative + ' when done.\n');
    return;
  }
  spawnSync('tmux', ['new-session', '-s', label, '-c', worktree.path, ...command], { stdio: 'inherit' });
  await endSessionWorktree(root, worktree, stdout);
}

async function endSessionWorktree(root, worktree, out) {
  const { removeWorktree } = await import('./worktrees.mjs');
  if (worktree.hook) {
    // Hook-created worktrees have no git status to check, so they are always kept.
    out.write('[worktree] Kept ' + worktree.path + ' (created by a WorktreeCreate hook). Delete it yourself when you are done.\n');
    return;
  }
  const { execFile } = await import('node:child_process');
  const git = (args, cwd) => new Promise((resolve) => execFile('git', args, { cwd }, (error, stdout) => resolve(error ? null : stdout.trim())));
  const status = await git(['status', '--porcelain', '--untracked-files=all'], worktree.path);
  const head = await git(['rev-parse', 'HEAD'], worktree.path);
  if (status === '' && head === worktree.base) {
    await removeWorktree(root, worktree, { deleteBranch: true });
    out.write('[worktree] No changes, so the worktree and branch ' + worktree.branch + ' were removed.\n');
    return;
  }
  out.write('[worktree] Kept ' + worktree.relative + ' (branch ' + worktree.branch + ')' + (status ? ' with uncommitted changes' : '') + '. Review with: git -C ' + worktree.relative + ' diff, merge with: git merge ' + worktree.branch + ', remove with: git worktree remove ' + worktree.relative + '\n');
}

// /loop: run the prompt, wait, repeat. Ctrl+C stops the current run and the loop.
// Trust and deny rules decide whether a command's !`cmd` lines may run.
async function customCommandContext(root) {
  const { PermissionPolicy } = await import('./permissions.mjs');
  const settings = await loadSettings(root).catch(() => null);
  return { env: process.env, trusted: Boolean(settings && settings.trusted), policy: settings ? new PermissionPolicy(settings) : null, disableShell: Boolean(settings && settings.disableSkillShellExecution) };
}

function customRunOptions(custom) {
  const command = custom.command;
  return {
    ...(command.model ? { model: command.model } : {}),
    ...(command.effort ? { effort: command.effort } : {}),
    ...(custom.grantTools ? { grantTools: custom.grantTools } : {}),
    expansion: { command_name: custom.name, command_source: command.scope || command.source || 'project', command_args: String(custom.args || ''), prompt: String(custom.prompt || '').slice(0, 20000) },
    ...(command.context === 'fork' ? { fork: { agent: command.agent, label: '/' + custom.name } } : {})
  };
}

function reportInlineShell(ran = []) {
  for (const item of ran) stdout.write(item.skipped ? '[command] Skipped !`' + item.command + '`: ' + item.skipped + '\n' : '[command] Ran !`' + item.command + '`' + (item.code ? ' (exit ' + item.code + ')' : '') + '\n');
}

async function runLoop(loop, root, autoApprove, session, persistence) {
  let stopped = false;
  let wake = null;
  const onStop = () => { stopped = true; if (wake) wake(); };
  process.on('SIGINT', onStop);
  try {
    for (let run = 1; !stopped && run <= (loop.times || 1000); run += 1) {
      stdout.write('[loop] Run ' + run + (loop.times ? ' of ' + loop.times : '') + '\n');
      let prompt = loop.prompt;
      let loopOptions = {};
      if (prompt.startsWith('/')) {
        const custom = await resolveCustomCommand(root, prompt, await customCommandContext(root)).catch(() => null);
        if (custom) { reportInlineShell(custom.shell); prompt = custom.prompt; loopOptions = customRunOptions(custom); }
      }
      if (loop.selfPaced) {
        loopOptions = { ...loopOptions, selfPacedLoop: true };
        if (session) session.loopWakeup = null;
        if (run === 1) prompt += '\n\n(This is a self-paced loop. After this run, call schedule_wakeup with delay_seconds for when to check again and a short reason, or with stop: true once the task is done or no longer needs checking.)';
      }
      session = await runPrompt(prompt, root, autoApprove, session, persistence, loopOptions);
      persistence.resumeId = null;
      if (AUTO_HALT) { stdout.write('[loop] Stopping: the last run hit a ' + (AUTO_HALT.kind === 'billing_error' ? 'billing/quota' : 'authentication') + ' error, so further runs would fail too.\n'); break; }
      const wakeup = loop.selfPaced && session ? session.loopWakeup : null;
      if (session && loop.selfPaced) session.loopWakeup = null;
      if (wakeup && wakeup.stop) { stdout.write('[loop] The model ended the loop' + (wakeup.reason ? ': ' + wakeup.reason : '.') + '\n'); break; }
      // Claude Code 2.1.319: a self-paced run that does not reschedule ends
      // the loop rather than waking again on a guessed default.
      if (loop.selfPaced && !(wakeup && wakeup.delayMs) && !/^(1|true|yes|on)$/i.test(String(process.env.OASIS_LOOP_KEEPALIVE || ''))) {
        stdout.write('[loop] The run finished without scheduling another, so the loop ends. Set OASIS_LOOP_KEEPALIVE=1 to keep waking every ' + formatInterval(loop.intervalMs) + ' instead.\n');
        break;
      }
      if (stopped || (loop.times && run >= loop.times)) break;
      const delayMs = wakeup && wakeup.delayMs ? wakeup.delayMs : loop.intervalMs;
      stdout.write('[loop] Next run in ' + formatInterval(delayMs) + (wakeup && wakeup.reason ? ' (' + wakeup.reason + ')' : loop.selfPaced ? ' (no schedule_wakeup call; OASIS_LOOP_KEEPALIVE)' : '') + '. Press Ctrl+C to stop.\n');
      await new Promise((resolve) => { const timer = setTimeout(resolve, Number(process.env.OASIS_LOOP_DELAY_SCALE ? delayMs * Number(process.env.OASIS_LOOP_DELAY_SCALE) : delayMs)); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = null;
    }
  } finally { process.removeListener('SIGINT', onStop); }
  if (session) session.selfPacedLoop = false;
  stdout.write('[loop] Stopped.\n');
  return session;
}

// Claude Code 2.1.304 warns before an inactive conversation is resumed at
// full price. Provider prompt caches last minutes to hours, so resuming an
// old, long session re-sends the whole history uncached on the next message.
export function resumeCostNotice({ tokens = 0, updatedAt = '', price = null, now = Date.now() } = {}) {
  const idleMs = now - (Date.parse(updatedAt || '') || now);
  if (!price || !(Number(price.input) > 0) || tokens < 30000 || idleMs < 60 * 60 * 1000) return '';
  const cost = tokens * Number(price.input) / 1e6;
  if (cost < 0.05) return '';
  return '[session] This conversation has about ' + Math.round(tokens / 1000) + 'k tokens and has been idle, so the provider cache has likely expired: the next message re-sends it for about ' + formatUsd(cost) + '. /compact first to shrink it, or /clear to start fresh.\n';
}

// A resumed session whose goal was paused (Ctrl+C, turn limit, or OASIS
// stopping mid-goal) says so, so the goal is not silently forgotten.
export function pausedGoalNotice(goal) {
  if (!goal || goal.achieved || !goal.condition || (!goal.paused && !goal.active)) return '';
  const condition = String(goal.condition).replace(/\s+/g, ' ').slice(0, 120);
  return '[goal] Paused goal: ' + condition + (goal.turns ? ' (' + goal.turns + ' turn(s) so far)' : '') + '. /goal resume continues it; /goal clear drops it.\n';
}

async function runGoal(goal, root, autoApprove, session, persistence) {
  let stopped = false;
  const onStop = () => { stopped = true; };
  process.on('SIGINT', onStop);
  const { evaluateGoal } = await import('./agent.mjs');
  const startTurns = Math.max(0, Number(goal.turns) || 0);
  const limit = startTurns + goal.maxTurns;
  let state = { condition: goal.condition, active: true, paused: false, achieved: false, turns: startTurns, reason: goal.reason || '' };
  if (session) session.goal = state;
  try {
    let prompt = startTurns && state.reason
      ? 'Resuming the goal: ' + goal.condition + '\nThe last check said: ' + state.reason + '\nInspect the current state first, do not repeat finished work, verify results by running checks, and keep going until it is fully met.'
      : 'Goal: ' + goal.condition + '\nWork toward this goal now. Verify results by running checks, not by assumption. Keep going until it is fully met.';
    while (!stopped && state.active && state.turns < limit) {
      state.turns += 1;
      stdout.write('[goal] Turn ' + (state.turns - startTurns) + ' of up to ' + goal.maxTurns + (startTurns ? ' (' + state.turns + ' in total)' : '') + '\n');
      session = await runPrompt(prompt, root, autoApprove, session, persistence);
      persistence.resumeId = null;
      if (!session) break;
      if (session.goal && session.goal !== state && !session.goal.active) break;
      session.goal = state;
      if (stopped || !state.active) break;
      const verdict = await evaluateGoal(session, goal.condition).catch((error) => ({ met: false, reason: 'Check failed: ' + error.message }));
      state.reason = verdict.reason;
      if (verdict.met) { state.achieved = true; state.active = false; stdout.write('[goal] Met: ' + verdict.reason + '\n'); break; }
      stdout.write('[goal] Not met yet: ' + verdict.reason + '\n');
      prompt = 'The goal is not met yet. A reviewer said: ' + verdict.reason + '\nContinue working toward the goal: ' + goal.condition;
    }
  } finally { process.removeListener('SIGINT', onStop); }
  if (state.active) {
    // Ctrl+C or the turn limit: keep the goal so /goal resume can pick it up.
    state.active = false;
    state.paused = true;
    stdout.write('[goal] Paused after ' + state.turns + ' turn(s)' + (stopped ? '' : ' (turn limit reached)') + '. /goal shows the last check; /goal resume continues.\n');
  }
  if (session) {
    session.goal = state;
    if (persistence && persistence.enabled) {
      try { const { saveSession } = await import('./sessions.mjs'); await saveSession(session, { env: process.env }); } catch { /* saving is best effort; the next turn saves again */ }
    }
  }
  return session;
}

async function memoryCommand(args, root) {
  const { runBuiltinCommand } = await import('./slash.mjs');
  const handled = await runBuiltinCommand('memory', args.join(' '), { root, env: process.env });
  stdout.write(handled.output + '\n');
}

async function interactiveCommandList(root) {
  const list = Object.entries(BUILTIN_COMMANDS).map(([name, description]) => ({ name, description }));
  list.push({ name: 'init', description: 'Create project instructions for this workspace' }, { name: 'quit', description: 'Exit Oasis' });
  try { for (const [name, command] of (await loadCustomCommands(root, { env: process.env })).entries()) list.push({ name, description: (command && command.description) || 'Custom command' }); } catch {}
  try { for (const skill of await listAvailableSkills(root, { env: process.env })) list.push({ name: skill.name, description: skill.description ? 'Skill: ' + String(skill.description).slice(0, 70) : 'Skill' }); } catch {}
  return list;
}

async function pasteClipboardImage(root) {
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  const attempts = process.platform === 'darwin'
    ? [['pngpaste', ['-']], ['osascript', ['-e', 'set png to (the clipboard as «class PNGf»)', '-e', 'set f to (open for access POSIX file "/dev/stdout" with write permission)', '-e', 'write png to f', '-e', 'close access f']]]
    : process.platform === 'win32' ? []
      : [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 5000 });
    const data = result.stdout;
    if (result.status === 0 && data && data.length > 8 && data[0] === 0x89 && data[1] === 0x50) {
      const dir = path.join(root, '.oasis', 'pastes');
      await mk(dir, { recursive: true });
      const name = 'paste-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      await wf(path.join(dir, name), data);
      return '@.oasis/pastes/' + name;
    }
  }
  return null;
}

// /vim and the "editorMode" setting; Claude Code's ~/.claude.json editorMode is honored too.
let claudeEditorMode;
function editorModeFor(session) {
  if (SESSION_OPTIONS.editorMode) return SESSION_OPTIONS.editorMode;
  if (session && session.settings && session.settings.editorMode) return session.settings.editorMode;
  if (claudeEditorMode === undefined) {
    claudeEditorMode = null;
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const raw = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
      if (raw && (raw.editorMode === 'vim' || raw.editorMode === 'normal')) claudeEditorMode = raw.editorMode;
    } catch {}
  }
  return claudeEditorMode || 'normal';
}

async function readMainInput(root, session, state) {
  if (!stdin.isTTY || !stdout.isTTY || process.env.OASIS_SIMPLE_INPUT === '1') return askLine('\nYou> ');
  const color = colorEnabled(stdout);
  const currentMode = () => (session && session.permissions ? session.permissions.mode : SESSION_OPTIONS.permissionMode || 'default');
  stdout.write('\n');
  const initialText = queuedDraft;
  queuedDraft = '';
  const result = await readInput({
    initialText,
    history: state.history,
    color,
    vim: editorModeFor(session) === 'vim',
    prompt: (editor) => promptFor(editor.text, color),
    footer: (editor) => {
      const model = session && session.config && session.config.model || '';
      const contextPercent = session && Array.isArray(session.messages)
        ? contextTokens(session).tokens / Math.max(1, contextWindowSize(session.config, process.env)) * 100
        : null;
      const spentUsd = session && session.budgetLedger ? session.budgetLedger.spentUsd : (session && typeof session.costUsd === 'number' ? session.costUsd : null);
      const budgetUsd = session && Number(session.maxBudgetUsd) > 0 ? Number(session.maxBudgetUsd) : Number(SESSION_OPTIONS.maxBudgetUsd) || 0;
      const priced = session && session.config ? priceFor(model, { config: session.config, overrides: session.pricing || {}, env: process.env }) : null;
      const costLabel = session ? (priced ? formatUsd(spentUsd == null ? 0 : spentUsd) : 'unknown') : '';
      return footerFor({ text: editor.text, mode: currentMode(), color, model, contextPercent, costLabel, budgetUsd, spentUsd });
    },
    complete: state.completer,
    onShiftTab: async () => {
      const mode = nextMode(currentMode(), { allowBypass: Boolean(SESSION_OPTIONS.allowBypass) });
      await runBuiltinCommand('mode', mode, { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS });
    },
    onReady: (submit) => { IDLE_SUBMIT = submit; setTimeout(() => wakeIfPending(session), 0); },
    onDoubleEscape: () => '/rewind',
    onPasteImage: () => pasteClipboardImage(root),
    voice: {
      enabled: () => {
        if (session && session.settings && session.settings.voiceDisabledByPolicy) return false;
        if (/^(0|false|off|1|true|on)$/i.test(String(process.env.OASIS_VOICE || ''))) return /^(1|true|on)$/i.test(process.env.OASIS_VOICE);
        if (typeof SESSION_OPTIONS.voiceEnabled === 'boolean') return SESSION_OPTIONS.voiceEnabled;
        const settings = session && session.settings || {};
        return settings.voiceEnabled === true || Boolean(settings.voice && settings.voice.enabled === true);
      },
      settings: () => (session && session.settings) || {},
      // The project's name helps the transcriber spell it.
      hints: () => [path.basename(root)]
    },
    onCommandPalette: async () => {
      const commands = await interactiveCommandList(root);
      const commandItems = commands.map((item) => ({
        label: '/' + String(item.name || '').slice(0, 100),
        description: redactApprovalSecrets(String(item.description || '')).slice(0, 180),
        value: '/' + String(item.name || '').slice(0, 100),
        category: Object.hasOwn(BUILTIN_COMMANDS, item.name) ? 'Commands' : 'Custom / skill'
      })).filter((item) => item.label.length > 1);
      const settingsItems = [
        { label: 'Provider setup', description: 'Connect or change your model provider', value: '/setup', category: 'Settings' },
        { label: 'Model for this session', description: 'View or switch the current model', value: '/model', category: 'Settings' },
        { label: 'Permission mode', description: 'Choose Ask, Plan, Auto, or edit mode', value: '/mode', category: 'Settings' },
        { label: 'Permission rules', description: 'Review allow, ask, and deny rules', value: '/permissions', category: 'Settings' },
        { label: 'General settings', description: 'Open the configuration panel', value: '/config', category: 'Settings' },
        { label: 'Keyboard shortcuts', description: 'Show the shortcut cheat sheet', value: '/keys', category: 'Settings' },
        { label: 'Appearance', description: 'Change the prompt colour', value: '/color', category: 'Settings' }
      ];
      const recentItems = (await listSessions(root, { env: process.env }).catch(() => [])).filter((item) => !item.archived)
        .slice(0, 12)
        .map((item) => {
          const date = Number.isFinite(Date.parse(item.updatedAt || '')) ? new Date(item.updatedAt).toLocaleString() : 'saved session';
          return {
            label: 'Resume session ' + String(item.id || '').slice(0, 8),
            description: [item.model || 'model not recorded', date].join(' · '),
            value: '/resume ' + String(item.id || ''),
            category: 'Recent sessions'
          };
        });
      return [...settingsItems, ...recentItems, ...commandItems];
    },
    onTranscript: async () => {
      const { transcriptLines } = await import('./terminal-ui.mjs');
      return { pager: transcriptLines(session ? session.messages : [], { color: colorEnabled(stdout), width: stdout.columns || 100 }) };
    },
    onTodos: async () => {
      const handled = await runBuiltinCommand('todos', '', { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS }).catch(() => null);
      return handled ? String(handled.output).split('\n') : [];
    }
  });
  IDLE_SUBMIT = null;
  if (result.type === 'eof') throw new Error('eof');
  if (result.text.startsWith(WAKE_PREFIX)) return result.text;
  state.history.push(result.text);
  appendHistory(root, result.text).catch(() => {});
  return result.text;
}

// Settings "env" (Claude Code key) is applied to process.env before the provider loads;
// "disableBypassPermissionsMode": "disable" (often from managed settings) blocks bypass mode.
async function applySettingsPolicy(root, autoApprove, keepSessionIds = []) {
  const settings = await loadSettings(root).catch(() => null);
  if (!settings) return;
  // "cleanupPeriodDays" (Claude Code key, opt-in): quietly delete saved chats unused for that long.
  const cleanupDays = Number.parseInt(process.env.OASIS_CLEANUP_PERIOD_DAYS || '', 10) || settings.cleanupPeriodDays;
  if (Number.isInteger(cleanupDays) && cleanupDays >= 1) pruneSessions(root, cleanupDays, { keep: keepSessionIds.filter(Boolean) }).catch(() => {});
  for (const [key, value] of Object.entries(settings.env || {})) process.env[key] = value;
  if (settings.apiKeyHelper && !process.env.OASIS_API_KEY_HELPER) process.env.OASIS_API_KEY_HELPER = settings.apiKeyHelper;
  if (settings.customHeadersHelper && !process.env.OASIS_CUSTOM_HEADERS_HELPER) process.env.OASIS_CUSTOM_HEADERS_HELPER = settings.customHeadersHelper;
  if (settings.permissions && settings.permissions.disableBypassPermissionsMode) {
    if (SESSION_OPTIONS.permissionMode === 'bypassPermissions') throw new Error('bypassPermissions mode is disabled by settings (permissions.disableBypassPermissionsMode).');
    SESSION_OPTIONS.disableBypass = true;
  }
}

// /reload-plugins and /reload-skills: rebuild the session (settings, plugins, skills,
// agents, hooks, MCP servers, system prompt) while keeping the conversation.
async function reloadSessionComponents(session, root, what) {
  const { rebuildSession } = await import('./agent.mjs');
  const { session: next, summary } = await rebuildSession(session, { root, ...sessionCreateOptions(), watchFiles: true }, what);
  attachMonitors(next);
  stdout.write(summary + '\n');
  return next;
}

// /theme and the "theme" setting (Claude Code's ~/.claude.json theme is honored too).
async function applyThemeFromSettings(settings) {
  if (process.env.OASIS_SAFE_MODE === '1') return;
  try {
    const { applyTheme, resolveTheme, themePreference } = await import('./themes.mjs');
    applyTheme(resolveTheme(themePreference({ env: process.env, settings }), { env: process.env, plugins: (settings && settings.pluginThemeSources) || [] }));
  } catch {}
}

// Show which conversation came back as soon as it is picked, not on the next
// message. The session itself still loads lazily with the first prompt.
async function showResumeRecap(root, persistence) {
  try {
    const saved = await loadSession(root, persistence.resumeId);
    const text = sessionRecap(saved, { width: stdout.columns || 80 });
    if (!text) return;
    stdout.write(text);
    persistence.recapShown = saved.id;
  } catch {}
}

async function interactive(root, autoApprove, persistence = {}) {
  let session = null;
  // Interactive mode reads from a terminal. Piped or redirected input used to
  // print "Oasis session closed." and exit without saying why.
  if (!stdin.isTTY && process.env.OASIS_SIMPLE_INPUT !== '1') {
    stderr.write('oasis: interactive mode needs a terminal, and input here is piped or redirected.\n' +
      'To run a task from a script, use print mode:\n' +
      '  oasis -p "fix the failing test"\n' +
      '  echo "fix the failing test" | oasis -p\n');
    process.exitCode = 2;
    return session;
  }
  // Keep model windows and prices current (models.dev, at most daily, in the background).
  import('./model-catalog.mjs').then(({ refreshModelCatalog }) => refreshModelCatalog()).catch(() => {});
  await ensureModelProviderSetup(root);
  const bannerConfig = await loadConfig().catch(() => ({}));
  const startupSettings = await loadSettings(root).catch(() => null);
  await applyThemeFromSettings(startupSettings);
  if (stdout.isTTY && process.env.OASIS_DISABLE_THEME_RELOAD !== '1') {
    import('./themes.mjs').then(({ watchThemes }) => watchThemes({ env: process.env, plugins: (startupSettings && startupSettings.pluginThemeSources) || [], onReload: (theme) => stdout.write('\n[theme] reloaded ' + theme.name + '\n') })).catch(() => {});
  }
  if (stdout.isTTY) await showStartupBanner({ root, model: SESSION_OPTIONS.model || (bannerConfig.configured === false ? 'not set up yet · exit and run oasis setup' : bannerConfig.model) || '', provider: bannerConfig.configured === false ? '' : bannerProviderLabel(bannerConfig), mode: SESSION_OPTIONS.permissionMode || 'default' }).catch(() => {});
  else stdout.write('\nOASIS — coding agent\nWorkspace: ' + root + '\nType your task in plain English. Use /help or /exit. Commands run locally; review permissions carefully.\n');
  if (stdout.isTTY) {
    try {
      const { cliUpdateNotice } = await import('./app-update.mjs');
      const { getBaseConfigDirectory } = await import('./config.mjs');
      const { oasisVersion } = await import('./version.mjs');
      const notice = await cliUpdateNotice({ statePath: path.join(getBaseConfigDirectory(process.env), 'update-state.json'), currentVersion: oasisVersion() });
      if (notice) stdout.write((colorEnabled(stdout) ? '\x1b[33m' : '') + notice + (colorEnabled(stdout) ? '\x1b[39m' : '') + '\n');
    } catch {}
  }
  if (process.env.OASIS_BACKGROUND_NOTICE !== '0') {
    try {
      const bg = await import('./background-sessions.mjs');
      const notice = bg.backgroundStartupNotice(await bg.listBackgroundSessions(process.env), root);
      if (notice) stdout.write(notice + '\n');
    } catch {}
  }
  if (stdout.isTTY && !SESSION_OPTIONS.safeMode) {
    try {
      const { importStartupNotice } = await import('./importers.mjs');
      const notice = await Promise.race([importStartupNotice(root, { env: process.env }), new Promise((resolve) => setTimeout(() => resolve(''), 1500).unref())]);
      if (notice) stdout.write(notice + '\n');
    } catch {}
  }
  if (SESSION_OPTIONS.devChannels.length) {
    stdout.write('\n\x1b[1mWARNING: loading development channels\x1b[22m\n  ' + SESSION_OPTIONS.devChannels.join('\n  ') + '\nAnything that can reach these servers can put text in front of the agent' + '. Only use channels you trust.\n');
    const answer = await askLine('Type "yes" if you are using this for local development (anything else exits): ').catch(() => '');
    if (String(answer).trim().toLowerCase() !== 'yes') { stdout.write('Exiting.\n'); return; }
    SESSION_OPTIONS.devChannelsConfirmed = true;
  }
  // Channels push messages before you type anything, so start the session (and its MCP servers) now.
  if (SESSION_OPTIONS.channels.length || SESSION_OPTIONS.devChannelsConfirmed) {
    const config = await loadConfig().catch(() => null);
    if (config && config.configured) {
      if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
      let restored = null;
      if (persistence.resumeId) { restored = await loadSession(root, persistence.resumeId).catch(() => null); persistence.resumeId = null; }
      session = await createSession({ root, config, restore: restored, ...sessionCreateOptions(), watchFiles: true });
      const { channelClients } = await import('./channels.mjs');
      const live = channelClients(session).map((client) => client.config.name);
      const requested = session.channels.map((entry) => entry.raw);
      stdout.write('[channels] ' + (live.length ? 'Listening on ' + live.join(', ') : 'No connected MCP server declared the claude/channel capability for ' + requested.join(', ')) + '.\n');
      if (session.settings && session.settings.channelsEnabled === false) stdout.write('[channels] channelsEnabled is false in settings, so channel messages are dropped.\n');
    }
  }
  // An --agent with initialPrompt starts working right away, as in Claude Code.
  const mainAgentName = SESSION_OPTIONS.bare || SESSION_OPTIONS.safeMode ? null : SESSION_OPTIONS.agent || (startupSettings && startupSettings.agent) || null;
  if (mainAgentName && !QUEUED_INPUT.length && !persistence.resumeId && !session) {
    const definition = (await loadAgentDefinitions(root).catch(() => ({})))[String(mainAgentName).toLowerCase()];
    if (definition && definition.initialPrompt) { QUEUED_INPUT.push(definition.initialPrompt); SESSION_OPTIONS.agentInitialPromptSent = true; }
  }
  if (persistence.resumeId && !session) await showResumeRecap(root, persistence);
  const inputState = { history: await loadHistory(root).catch(() => []), completer: createCompleter({ root, commands: () => interactiveCommandList(root), fileSuggestion: () => (session && session.settings || startupSettings || {}).fileSuggestion || null }) };
  const pendingShell = [];
  while (true) {
    let input;
    spinnerVerbsSetting = (session && session.settings || startupSettings || {}).spinnerVerbs || null;
    const statusLine = (session && session.settings || startupSettings || {}).statusLine;
    if (statusLine) {
      const line = await renderStatusLine(statusLine, statusLinePayload({ root, session, config: await loadConfig().catch(() => ({})), usage: USAGE, outputStyle: SESSION_OPTIONS.outputStyle }), { root, env: process.env, keepColor: Boolean(stdout.isTTY) }).catch(() => null);
      if (line) stdout.write('\n' + line);
    }
    // With subagentStatusLine set, running subagents get a row each above the prompt.
    if (session && session.settings && session.settings.subagentStatusLine && session.agentTasks) {
      const records = [...session.agentTasks.agents.values()].filter((record) => record.status === 'running').slice(0, 20);
      const rows = records.length ? await subagentRows({ root, session, env: process.env, width: stdout.columns || 100, color: Boolean(stdout.isTTY && colorEnabled(stdout)) }, records).catch(() => new Map()) : new Map();
      for (const record of records) {
        const row = rows.has(record.id) ? rows.get(record.id) : record.id + ' ' + (record.type || 'agent') + ': ' + String(record.description || '').slice(0, 120) + ' · ' + (record.toolCalls || 0) + ' tool calls';
        if (row) stdout.write('\n  ' + row);
      }
    }
    attachCron(session);
    attachMonitors(session);
    if (QUEUED_INPUT.length) {
      input = QUEUED_INPUT.shift();
      stdout.write('\n' + (colorEnabled(stdout) ? '\x1b[2m❯ ' + input + '\x1b[22m' : '> ' + input) + '\n');
      inputState.history.push(input);
      appendHistory(root, input).catch(() => {});
    } else {
      const idle = startIdleCompaction(session, {
        minutes: idleCompactMinutes(session && session.settings, process.env),
        compact: async (target, options) => {
          const before = estimateTokens(target.messages);
          const result = await compactHistoryIfNeeded(target, { ...options, mustPreserve: target.mustPreserve });
          if (result && result.tokensUsed) recordUsage(USAGE, { totalTokens: result.tokensUsed, phase: 'compaction' });
          return result && result.compacted ? { ...result, beforeTokens: before, afterTokens: estimateTokens(target.messages) } : result;
        }
      });
      try { input = await readMainInput(root, session, inputState); } catch { await idle.settle(); break; }
      const idleResult = await idle.settle();
      if (idleResult) { stdout.write(idleCompactionNote(idleResult) + '\n'); saveSession(session).catch((error) => stderr.write('Could not save the compacted session: ' + (error && error.message || error) + '\n')); }
    }
    let text = input.trim();
    if (!text) continue;
    if (text.startsWith('!') && text.length > 1) {
      const command = text.slice(1).trim();
      if (SESSION_OPTIONS.restricted) { stdout.write('[restricted] ! shell commands are disabled in --restricted mode.\n'); continue; }
      let powershell = null;
      if (((await loadSettings(root).catch(() => ({}))).defaultShell) === 'powershell') {
        const { findPowerShell } = await import('./power-tools.mjs');
        powershell = findPowerShell(process.env);
        if (!powershell) stdout.write('[shell] defaultShell is powershell, but the PowerShell tool is not enabled or pwsh was not found; using the normal shell.\n');
      }
      const ran = await runShellPassthrough(command, { root, powershell });
      if (ran.code) stdout.write((colorEnabled(stdout) ? '\x1b[2m' : '') + '[exit ' + ran.code + ']' + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n');
      pendingShell.push({ command, code: ran.code, output: ran.output });
      if (pendingShell.length > 10) pendingShell.shift();
      continue;
    }
    if (pendingShell.length && !text.startsWith('/') && !text.startsWith('#')) {
      text = 'Commands I ran in my terminal (for context):\n' + shellContextBlock(pendingShell) + '\n\n' + text;
      pendingShell.length = 0;
    }
    if (['/exit', '/quit', 'exit', 'quit'].includes(text.toLowerCase())) break;
    if (text.startsWith('#') && !text.startsWith('#!')) {
      try {
        const scope = /^#\s*user:/i.test(text) ? 'user' : /^#\s*local:/i.test(text) ? 'local' : 'project';
        const note = text.replace(/^#+\s*(?:(?:user|local|project):)?\s*/i, '');
        const file = await appendMemoryNote(root, note, { scope });
        if (session && session.messages && session.messages[0]) {
          const line = '\n- ' + note;
          session.baseSystemPrompt = (session.baseSystemPrompt || session.messages[0].content) + line;
          session.messages[0].content += line;
        }
        stdout.write('[memory] Saved to ' + file + '\n');
      } catch (error) { stdout.write('[memory] ' + error.message + '\n'); }
      continue;
    }
    if (text === '/clear' || text === '/new' || text === '/reset') { closeSession(session); session = null; persistence.resumeId = null; stdout.write('Conversation context cleared. Project instructions will be loaded again on the next task.\n'); continue; }
    if (text === '/status') { try { printConfig(await loadConfig()); } catch (e) { stdout.write(e.message + '\n'); } continue; }
    if (text === '/setup') { try { await configureProvider(root); closeSession(session); session = null; persistence.resumeId = null; } catch (e) { stdout.write(e.message + '\n'); } continue; }
    const slash = text.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i);
    // Aliases yield to a custom command of the same name (a personal /ask.md stays yours).
    if (slash && !Object.hasOwn(BUILTIN_COMMANDS, slash[1].toLowerCase()) && Object.hasOwn(COMMAND_ALIASES, slash[1].toLowerCase()) && !(await loadCustomCommands(root, { env: process.env }).catch(() => new Map())).has(slash[1].toLowerCase())) slash[1] = COMMAND_ALIASES[slash[1].toLowerCase()];
    if (slash && Object.hasOwn(BUILTIN_COMMANDS, slash[1].toLowerCase())) {
      // /config without an argument opens the settings pane in a terminal.
      if (slash[1].toLowerCase() === 'config' && !String(slash[2] || '').trim() && stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && process.env.OASIS_LINE_APPROVALS !== '1') {
        try {
          const pane = await import('./config-pane.mjs');
          const { selectDialog } = await import('./select-dialog.mjs');
          const state = { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS, autoApprove, color: Boolean(stdout.isTTY && colorEnabled(stdout)), width: stdout.columns || 100 };
          const run = (command, value) => runBuiltinCommand(command, value, state);
          let last = 0;
          for (;;) {
            const rows = await pane.configRows(state);
            const width = Math.max(...rows.map((row) => row.item.label.length));
            stdout.write('\nSettings — Enter to change, Esc when done:\n');
            const picked = await selectDialog({ input: stdin, output: stdout, options: [...rows.map((row, index) => ({ label: row.item.label.padEnd(width) + '  ' + row.value, value: String(index) })), { label: 'Done', value: null, hotkey: 'no' }], initial: last, context: 'Select', color: colorEnabled(stdout) });
            if (!picked) break;
            last = Number(picked);
            const row = rows[last];
            const choices = await row.item.choices(state);
            stdout.write(row.item.label + ' — ' + row.item.description + ':\n');
            const value = await selectDialog({ input: stdin, output: stdout, options: [...choices.map((choice) => ({ label: choice + (choice === row.value ? ' (current)' : ''), value: choice })), { label: 'Cancel', value: null, hotkey: 'no' }], initial: Math.max(0, choices.indexOf(row.value)), context: 'Select', color: colorEnabled(stdout) });
            if (!value || value === row.value) continue;
            try { stdout.write(String(await pane.setConfigValue(row.item.key, value, state, run)) + '\n'); } catch (error) { stdout.write('[config] ' + error.message + '\n'); }
          }
          session = state.session || session;
        } catch (error) { stdout.write('[config] ' + error.message + '\n'); }
        continue;
      }
      // /model, /theme and /color without an argument open a picker in a terminal.
      if (!String(slash[2] || '').trim() && stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && ['model', 'theme', 'color', 'rewind', 'presets'].includes(slash[1].toLowerCase()) && (slash[1].toLowerCase() !== 'rewind' || session)) {
        try {
          const { pickerFor, selectDialog } = await import('./select-dialog.mjs');
          const command = slash[1].toLowerCase();
          // Before the first message there is no session yet: list what the configured provider serves, not Claude aliases.
          let pickerSession = session;
          if (!pickerSession && command === 'model') {
            try {
              const pickerConfig = await loadConfig();
              if (SESSION_OPTIONS.model) pickerConfig.model = SESSION_OPTIONS.model;
              if (pickerConfig.configured) pickerSession = { config: pickerConfig, root };
            } catch { /* aliases only */ }
          }
          const picker = await pickerFor(command, { session: pickerSession, env: process.env, settings: (session && session.settings) || await loadSettings(root).catch(() => null) });
          if (picker) {
            stdout.write(command === 'rewind' ? 'Rewind to before which message?\n' : command === 'presets' ? 'Send which preset?\n' : 'Select ' + command + ':\n');
            const chosen = await selectDialog({ input: stdin, output: stdout, options: picker.options, initial: picker.initial, context: picker.context, color: colorEnabled(stdout) });
            if (!chosen) { stdout.write('Cancelled.\n'); continue; }
            slash[2] = chosen;
            if (command === 'rewind') {
              const modes = await pickerFor('rewind-mode');
              stdout.write('Restore what?\n');
              const mode = await selectDialog({ input: stdin, output: stdout, options: modes.options, initial: 0, context: modes.context, color: colorEnabled(stdout) });
              if (mode === null || mode === undefined) { stdout.write('Cancelled.\n'); continue; }
              slash[2] = (chosen + ' ' + mode).trim();
              // Put the rewound message back in the input box to edit and resend.
              const picked = picker.options.find((option) => option.value === chosen);
              if (mode !== 'code' && picked && picked.prompt) queuedDraft = picked.prompt;
            }
          }
        } catch (error) { stdout.write('[picker] ' + error.message + '\n'); continue; }
      }
      try {
        // /context before the first message: start the session now (the first
        // prompt would anyway) so it shows the real system prompt and tool cost,
        // as Claude Code does, instead of "no conversation yet".
        if (slash[1].toLowerCase() === 'context' && !session && !persistence.resumeId) {
          try {
            const config = await loadConfig();
            if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
            if (config.configured) session = await createSession({ root, config, ...sessionCreateOptions(), watchFiles: true });
          } catch { /* fall back to the plain message */ }
        }
        const handled = await runBuiltinCommand(slash[1].toLowerCase(), String(slash[2] || '').trim(), { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS, autoApprove, print: (line) => stdout.write(line + '\n'), color: Boolean(stdout.isTTY && colorEnabled(stdout)), width: stdout.columns || 100, confirm: (question) => askApproval(question, true, {}), ...(stdin.isTTY && stdout.isTTY ? { askUser: (question) => askQuestionInTerminal(question) } : {}) });
        if (handled) {
          if (handled.output) stdout.write((stdout.isTTY ? wrapCommandOutput(handled.output, stdout.columns || 80) : handled.output) + '\n');
          if (handled.reload && session) {
            session = await reloadSessionComponents(session, root, handled.reload);
            continue;
          }
          // /presets N: send the saved prompt or /command as if typed next.
          if (handled.queue) { QUEUED_INPUT.unshift(String(handled.queue)); continue; }
          if (handled.osc52 && stdout.isTTY) stdout.write('\x1b]52;c;' + handled.osc52 + '\x07');
          if (handled.forked) persistence.enabled = true;
          for (const service of handled.connect ? [].concat(handled.connect) : []) {
            try {
              const { runConnectService, connectInTerminal } = await import('./connectors.mjs');
              const { openInBrowser } = await import('./mcp-oauth.mjs');
              const result = await runConnectService(session, { service }, { env: process.env, root, ...(stdin.isTTY && stdout.isTTY ? { connectorCard: (flow) => connectInTerminal(flow, { write: (text) => stdout.write(text), askLine: (question) => askLine(question), askSecret: (question) => askSecret(question), open: (url) => openInBrowser(url), width: stdout.columns || 80 }) } : {}) });
              stdout.write((result.skipped ? 'Not connected.' : result.message || (result.connected ? 'Connected.' : 'Not connected.')) + '\n');
            } catch (error) { stdout.write('[connect] ' + error.message + '\n'); }
          }
          if (handled.mcpLogin) {
            try { stdout.write((await (await import('./mcp-auth-commands.mjs')).mcpLogin(root, handled.mcpLogin, { env: process.env, session, print: (text) => stdout.write(text + '\n') })) + '\n'); }
            catch (error) { stdout.write('[mcp] ' + error.message + '\n'); }
          }
          if (handled.resume) { closeSession(session); session = null; persistence.enabled = true; persistence.resumeId = handled.resume; await showResumeRecap(root, persistence); }
          if (handled.focus) {
            if (stdout.isTTY) {
              stdout.write('\x1b[?1049h\x1b[H\x1b[2J' + handled.focus + '\n\n');
              try { await askLine('Press Enter to return '); } catch {}
              stdout.write('\x1b[?1049l');
            } else stdout.write(handled.focus + '\n');
            continue;
          }
          if (handled.background) {
            try {
              if (!session) throw new Error('Start a conversation first; /background hands the current session to a background agent.');
              const saved = await saveSession(session);
              const { startBackgroundSession } = await import('./background-sessions.mjs');
              const entry = await startBackgroundSession({ root, prompt: handled.background.prompt, resumeId: saved.id, env: process.env, permissionMode: (session.permissions && session.permissions.mode !== 'bypassPermissions' ? session.permissions.mode : SESSION_OPTIONS.permissionMode) || null, model: session.config && session.config.model || null });
              stdout.write('Moved this conversation to background session ' + entry.id + '.\n  oasis bg logs ' + entry.id + ' --follow   watch progress\n  oasis bg attach ' + entry.id + '          continue it here later\n');
              closeSession(session); session = null;
              break;
            } catch (error) { stdout.write('[background] ' + error.message + '\n'); continue; }
          }
          if (handled.prompt) { session = await runPrompt(handled.prompt, root, autoApprove, session, persistence, handled.planOnly ? { planOnly: true } : {}); persistence.resumeId = null; }
          if (handled.cd) { persistence.watchPaths = await fireCwdChanged(session, root, handled.cd); closeSession(session); session = null; persistence.resumeId = null; root = handled.cd; try { process.chdir(root); } catch {} }
          if (handled.loop) session = await runLoop(handled.loop, root, autoApprove, session, persistence);
          if (handled.goal) session = await runGoal(handled.goal, root, autoApprove, session, persistence);
          continue;
        }
      } catch (error) { stdout.write('Command failed: ' + error.message + '\n'); continue; }
    }
    if (text.startsWith('/') && !SESSION_OPTIONS.disableSlashCommands) {
      try {
        const custom = await resolveCustomCommand(root, text, await customCommandContext(root));
        if (custom) {
          stdout.write('Running /' + custom.name + ' from ' + custom.command.file + '.\n');
          reportInlineShell(custom.shell);
          session = await runPrompt(custom.prompt, root, autoApprove, session, persistence, customRunOptions(custom));
          persistence.resumeId = null;
          continue;
        }
      } catch (error) {
        stdout.write('Could not run custom command: ' + error.message + '\n');
        continue;
      }
      try {
        const imported = await resolveImportedSlashCommand(root, text, { env: process.env });
        if (imported) {
          stdout.write('Running imported command /' + imported.alias + ' from ' + imported.sourcePath + '.\n');
          session = await runPrompt(imported.prompt, root, autoApprove, session, persistence);
          persistence.resumeId = null;
          continue;
        }
      } catch (error) {
        stdout.write('Could not resolve imported command: ' + error.message + '\n');
        continue;
      }
      if (/^\/mcp__[a-z0-9_-]+__/.test(text)) { session = await runPrompt(text, root, autoApprove, session, persistence); persistence.resumeId = null; continue; }
      const skillCommand = await resolveSkillCommand(root, text).catch(() => null);
      if (skillCommand) {
        stdout.write('Running the ' + skillCommand.name + ' skill.\n');
        session = await runPrompt(skillCommand.prompt, root, autoApprove, session, persistence, skillCommand.options);
        persistence.resumeId = null;
        continue;
      }
      stdout.write('Unknown command. Type /help to list built-in and custom commands.\n');
      continue;
    }
    const direct = parseInstallIntent(text);
    if (direct) {
      try { await installRequest(direct, root, autoApprove); } catch (error) { stdout.write('Install request failed: ' + error.message + '\n'); }
      continue;
    }
    session = await runPrompt(text, root, autoApprove, session, persistence);
    persistence.resumeId = null;
  }
  closeSession(session);
  stdout.write('\nOasis session closed.\n');
}


async function watchCommentsCommand(root, autoApprove, persistence = {}) {
  await ensureModelProviderSetup(root);
  const { watchAiComments } = await import('./ai-comments.mjs');
  let session = null;
  stdout.write('Watching ' + root + ' for AI comments. End a comment with AI! to request a change or AI? to ask a question; plain AI adds context. Press Ctrl+C to stop.\n');
  const watcher = watchAiComments(root, {
    onTrigger: async ({ byFile, prompt }) => {
      const where = [...byFile.entries()].map(([file, items]) => file + ':' + items.map((item) => item.line).join(',')).join('  ');
      stdout.write('\n[watch] ' + where + '\n');
      try { session = await runPrompt(prompt, root, autoApprove, session, persistence); }
      catch (error) { stderr.write('[watch] ' + (error && error.message || error) + '\n'); }
      stdout.write('\n[watch] Waiting for the next AI! or AI? comment.\n');
    },
    onError: (error) => stderr.write('[watch] ' + (error && error.message || error) + '\n')
  });
  await new Promise((resolve) => {
    const finish = () => { watcher.stop(); resolve(); };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  if (session) closeSession(session);
}

const WEB_HELP = [
  'Usage: oasis web [--open] [--host HOST] [--port PORT] [--tls-cert FILE --tls-key FILE] [--public-url URL] [--trust-proxy] [--persistent-key] [--allow-insecure-lan]',
  '       oasis web key [--rotate]   print (or replace) the saved access key',
  '',
  'Serves the OASIS browser workspace from this computer. The browser is only the interface;',
  'files, commands and model requests stay in this process.',
  '',
  '  --open                 open the workspace in your default browser',
  '  --host HOST            bind address (default 127.0.0.1; use 0.0.0.0 only on a trusted private network)',
  '  --port PORT            port (default 3917; 0 picks a free port)',
  '  --tls-cert FILE        serve HTTPS with this certificate (requires --tls-key)',
  '  --tls-key FILE         private key for --tls-cert',
  '  --public-url URL       the address people use to reach OASIS (domain, tunnel or proxy); accepts that host name',
  '  --allow-host HOST      accept another host name (repeatable; *.example.com allowed)',
  '  --trust-proxy          trust X-Forwarded-Proto/Host/For from a reverse proxy on this computer',
  '  --persistent-key       keep the same access key across restarts (implied by --public-url)',
  '  --allow-insecure-lan   allow plain HTTP on a non-loopback address',
  '',
  'Remote access: keep OASIS on 127.0.0.1 and put an HTTPS reverse proxy or tunnel in front of it,',
  'for example: oasis web --public-url https://oasis.example.com --trust-proxy. See docs/REMOTE-ACCESS.md.'
].join('\n');

async function startWebWorkspace(root, args) {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(WEB_HELP + '\n'); return; }
  if (args[0] === 'key') {
    const { loadAccessKey } = await import('./remote-access.mjs');
    const rotate = args.includes('--rotate');
    const saved = loadAccessKey({ rotate });
    if (saved.source === 'env') stdout.write('The access key comes from OASIS_WEB_TOKEN. Change that variable to replace it.\n');
    else stdout.write((rotate ? 'New access key saved' : saved.created ? 'Access key created' : 'Saved access key') + ' (' + saved.file + '):\n' + saved.key + '\n' + (rotate ? 'Restart oasis web for the new key to take effect. Old links stop working.\n' : ''));
    return;
  }
  await ensureModelProviderSetup(root);
  let publicUrl = '';
  const allowedHosts = [];
  let trustProxy = false;
  let persistentKey = false;
  let host = '127.0.0.1';
  let port = 3917;
  let tlsCertFile = null;
  let tlsKeyFile = null;
  let allowInsecureLan = false;
  let openBrowser = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host') {
      if (!args[i + 1]) throw new Error('--host requires a host address.');
      host = args[++i];
    } else if (arg.startsWith('--host=')) host = arg.slice(7);
    else if (arg === '--port') {
      if (!args[i + 1]) throw new Error('--port requires a number.');
      port = Number(args[++i]);
    } else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
    else if (arg === '--tls-cert') {
      if (!args[i + 1]) throw new Error('--tls-cert requires a certificate file path.');
      tlsCertFile = args[++i];
    } else if (arg.startsWith('--tls-cert=')) tlsCertFile = arg.slice(11);
    else if (arg === '--tls-key') {
      if (!args[i + 1]) throw new Error('--tls-key requires a private-key file path.');
      tlsKeyFile = args[++i];
    } else if (arg.startsWith('--tls-key=')) tlsKeyFile = arg.slice(10);
    else if (arg === '--allow-insecure-lan') allowInsecureLan = true;
    else if (arg === '--open') openBrowser = true;
    else if (arg === '--public-url' || arg.startsWith('--public-url=')) {
      const value = arg === '--public-url' ? args[++i] : arg.slice(13);
      if (!value) throw new Error('--public-url requires a URL such as https://oasis.example.com.');
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error('--public-url must be a full URL such as https://oasis.example.com.'); }
      if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('--public-url must use https:// so the access key and model keys are encrypted in transit.');
      publicUrl = parsed.origin;
    } else if (arg === '--allow-host' || arg.startsWith('--allow-host=')) {
      const value = arg === '--allow-host' ? args[++i] : arg.slice(13);
      if (!value) throw new Error('--allow-host requires a host name.');
      allowedHosts.push(value);
    } else if (arg === '--trust-proxy') trustProxy = true;
    else if (arg === '--persistent-key') persistentKey = true;
    else throw new Error('Unknown web option: ' + arg + '. Supported options: --host HOST, --port PORT, --open, --tls-cert FILE, --tls-key FILE, --public-url URL, --allow-host HOST, --trust-proxy, --persistent-key, --allow-insecure-lan.');
  }
  {
    const { parseAllowedHosts } = await import('./remote-access.mjs');
    const bad = allowedHosts.filter((value) => parseAllowedHosts([value]).length === 0);
    if (bad.length) throw new Error('--allow-host value is not a valid host name: ' + bad[0]);
  }
  let token;
  if (persistentKey || publicUrl || process.env.OASIS_WEB_TOKEN) {
    const { loadAccessKey } = await import('./remote-access.mjs');
    token = loadAccessKey().key;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535 (0 chooses an available port).');
  const normalizedHost = host.toLowerCase();
  if (normalizedHost !== 'localhost' && isIP(host) === 0) throw new Error('--host must be localhost or a literal IP address. Use --host 0.0.0.0 only when you intentionally want other devices on your private network to connect.');
  const app = await startOasisWebServer({ root, host, port, tlsCertFile, tlsKeyFile, allowInsecureLan, publicUrl, allowedHosts, trustProxy, token });
  const scheme = app.secure ? 'https' : 'http';
  const urlHost = host.includes(':') ? '[' + host + ']' : host;
  const localUrl = scheme + '://' + (host === '0.0.0.0' ? '127.0.0.1' : urlHost) + ':' + app.port + '/';
  const connectUrl = localUrl + 'app/#token=' + app.token;
  stdout.write('\nOASIS is running for ' + root + '\n\n');
  stdout.write('  Open this link to start: ' + connectUrl + '\n');
  stdout.write('  Keep it private: anyone with the link can use this folder.\n\n');
  stdout.write('  Another browser? Open ' + localUrl + ' and paste the link above into the message box.\n\n');
  if (publicUrl) {
    stdout.write('  Remote link: ' + publicUrl + '/app/#token=' + app.token + '\n');
    stdout.write('  The access key is saved and survives restarts. Replace it with: oasis web key --rotate\n');
    if (!trustProxy && !app.secure) stdout.write('  Behind an HTTPS proxy or tunnel? Add --trust-proxy so OASIS sees the HTTPS origin.\n');
    stdout.write('\n');
  }
  stdout.write('Commands, package installs, file deletions and bundle installs always ask for your approval in the browser first.\n');
  try {
    const { missingAppPackages } = await import('./app-server.mjs');
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const missing = missingAppPackages(appRoot);
    if (missing.length) stderr.write('\nThe web app is missing ' + missing.join(', ') + ', so the page will not finish loading. Run npm install in ' + appRoot + ', then restart oasis web.\n');
  } catch { /* the check is advisory */ }
  let scheduler = null;
  try {
    const { hostScheduler } = await import('./routines.mjs');
    scheduler = await hostScheduler({ env: process.env, log: (line) => { if (process.env.OASIS_DEBUG) stderr.write('[routines] ' + line + '\n'); } });
    if (scheduler.hosted && scheduler.routines) stdout.write('Routines: ' + scheduler.routines + ' saved; this server runs them while it is open (oasis schedule list).\n');
  } catch (error) { stderr.write('Routines are not running: ' + error.message + '\n'); }
  if (host === '0.0.0.0' || (isIP(host) > 0 && !['127.0.0.1', '::1'].includes(host))) {
    let printedLinks = false;
    try {
      const { lanAddresses } = await import('./lan-addresses.mjs');
      const addresses = host === '0.0.0.0' ? lanAddresses() : [{ address: host, name: '', virtual: false, tailscale: false }];
      if (addresses.length) {
        stdout.write('\n  From another device on this network, open:\n');
        for (const entry of addresses.slice(0, 4)) stdout.write('    ' + scheme + '://' + entry.address + ':' + app.port + '/app/#token=' + app.token + (entry.tailscale ? '   (Tailscale)' : entry.virtual ? '   (virtual adapter)' : '') + '\n');
        printedLinks = true;
      }
    } catch {}
    if (app.secure) {
      stdout.write('HTTPS is active. The certificate must be trusted by each client device and include the exact LAN IP in its subject alternative names.\n');
      if (!printedLinks) stdout.write('From another device, open https://<this-computer-address>:' + app.port + '/ and paste the token.\n');
    } else {
      stdout.write('UNENCRYPTED LAN WARNING: explicit --allow-insecure-lan is active. The token and workspace traffic can be observed on the network. Never use public Wi-Fi or expose this port to the Internet.\n');
      if (!printedLinks) stdout.write('From another device, open http://<this-computer-address>:' + app.port + '/ and paste the token.\n');
    }
  } else if (!publicUrl) {
    stdout.write('Local only: other devices cannot connect. For remote access, put an HTTPS proxy or tunnel in front and pass --public-url (see oasis web --help).\n');
  }
  stdout.write('Press Ctrl+C to stop.\n');
  if (openBrowser) {
    const { openInBrowser } = await import('./mcp-oauth.mjs');
    if (!openInBrowser(connectUrl)) stdout.write('Could not open a browser automatically. Open the link above instead.\n');
  }
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // The in-process routine scheduler would otherwise keep the process alive.
    const stopping = [scheduler ? scheduler.stop().catch(() => {}) : null, app.close().catch((error) => stderr.write('Oasis web shutdown error: ' + error.message + '\n'))];
    // Supervisors expect a prompt exit: once the server has closed (sessions
    // saved), exit even if an idle keep-alive socket or child handle lingers,
    // and never take longer than a few seconds after the signal.
    void Promise.allSettled(stopping).then(() => exitAfterTelemetry(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}



// Commands that print their own detailed help for --help.
const SELF_HELP_COMMANDS = new Set(['connect', 'setup', 'update', 'web']);

// `oasis COMMAND --help` prints that command's lines from the main help instead
// of running it (some commands would otherwise create files or start servers).
function subcommandHelp(rawArgs) {
  const command = rawArgs[0];
  if (!command || command.startsWith('-') || SELF_HELP_COMMANDS.has(command)) return false;
  if (!rawArgs.slice(1).some((arg) => arg === '--help' || arg === '-h')) return false;
  const lines = helpText().split('\n');
  const pattern = new RegExp('^\\s+oasis ' + command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
  const matches = lines.filter((line) => pattern.test(line));
  if (!matches.length) return false;
  stdout.write('Usage:\n' + matches.join('\n') + '\n\nRun oasis --help for every command.\n');
  return true;
}

// Common top-level flags, for the "did you mean" hint on a typo.
const COMMON_FLAGS = ['--print', '--continue', '--resume', '--model', '--max-turns', '--output-format', '--yes', '--workspace', '--worktree',
  '--permission-mode', '--dangerously-skip-permissions', '--help', '--version', '--verbose', '--debug', '--name', '--bg', '--allowedTools',
  '--disallowedTools', '--add-dir', '--system-prompt', '--append-system-prompt', '--restricted', '--interactive', '--goal', '--effort',
  '--agent', '--sandbox', '--mcp-config', '--plugin-dir', '--settings', '--fork-session', '--session-id', '--json-schema', '--input-format',
  '--prompt-interactive', '--tmux', '--exec', '--init'];

/**
 * A leftover argument that looks like a flag (all known flags are consumed
 * before this) is a typo, not a task: Claude Code and Codex CLI reject it
 * instead of sending "--bogus" to the model. Returns '' for anything else.
 */
export function unknownOptionMessage(arg) {
  const text = String(arg || '');
  if (!/^--?[A-Za-z][\w-]*(?:=.*)?$/s.test(text)) return '';
  const name = text.replace(/=.*$/s, '');
  const scored = COMMON_FLAGS.map((flag) => [flag, levenshtein(name.toLowerCase(), flag.toLowerCase())]).sort((a, b) => a[1] - b[1]);
  const hint = scored[0] && scored[0][1] <= Math.max(2, Math.floor(name.length / 4)) ? ' Did you mean ' + scored[0][0] + '?' : '';
  return 'Unknown option ' + name + '.' + hint + ' Run oasis --help for options; to send text that starts with a dash as the task, put -- before it.';
}

// Command-line flags for a normal run (prompt, interactive or headless): sets
// SESSION_OPTIONS and environment switches directly, and the run's own
// choices (approval, persistence, resume, workspace, worktree, headless
// settings, leftover words) on `flags`.
async function parseMainFlags(rawArgs, flags) {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--yes' || arg === '-y' || arg === '--auto') { flags.autoApprove = true; if (arg !== '--auto') flags.explicitYes = true; continue; }
    if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) {
      // The Claude Agent SDK passes --permission-mode=MODE.
      const requestedMode = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      const mode = normalizePermissionMode(requestedMode);
      if (!mode) throw new Error('--permission-mode must be one of ' + PERMISSION_MODES.join(', ') + ' (aliases: manual, accept-edits).');
      SESSION_OPTIONS.permissionMode = mode;
      if (mode === 'bypassPermissions') flags.autoApprove = true;
      continue;
    }
    if (arg === '--allowedTools' || arg === '--allowed-tools' || arg === '--disallowedTools' || arg === '--disallowed-tools') {
      if (!rawArgs[i + 1]) throw new Error(arg + ' requires a comma- or space-separated rule list.');
      const rules = rawArgs[++i].split(/,(?![^(]*\))/).map((rule) => rule.trim()).filter(Boolean);
      (arg.toLowerCase().includes('disallowed') ? SESSION_OPTIONS.disallowedTools : SESSION_OPTIONS.allowedTools).push(...rules);
      continue;
    }
    if (arg === '--bare') { SESSION_OPTIONS.bare = true; continue; }
    if (arg === '--calm') { SESSION_OPTIONS.calm = true; process.env.OASIS_NO_ANIMATION = '1'; continue; }
    // --safe-mode: troubleshooting start without customizations (CLAUDE.md, skills, hooks, MCP, plugins,
    // custom commands, keybindings, themes, status line). Model, built-in tools and permissions stay.
    if (arg === '--safe-mode') { SESSION_OPTIONS.safeMode = true; process.env.OASIS_SAFE_MODE = '1'; process.env.CLAUDE_CODE_SAFE_MODE = '1'; continue; }
    // --restricted: no command execution or network tools (unless named in --tools), only managed and
    // --settings settings, and bypassPermissions is refused.
    if (arg === '--restricted') { SESSION_OPTIONS.restricted = true; process.env.OASIS_RESTRICTED = '1'; continue; }
    if (arg === '--allow-dangerously-skip-permissions') { SESSION_OPTIONS.allowBypass = true; continue; }
    if (arg === '--append-subagent-system-prompt') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(arg + ' requires a value.'); i += 1; SESSION_OPTIONS.subagentSystemAppend = [SESSION_OPTIONS.subagentSystemAppend, value].filter(Boolean).join('\n\n'); continue; }
    if (arg === '--append-subagent-system-prompt-file') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(arg + ' requires a file.'); i += 1; SESSION_OPTIONS.pendingFiles.push({ kind: 'subagent-append', file: value }); continue; }
    if (arg === '--permission-prompts') {
      const value = String(rawArgs[++i] || '').toLowerCase();
      if (!['none', 'host', 'default'].includes(value)) throw new Error('--permission-prompts must be none or host.');
      flags.headless.permissionPrompts = value; if (value === 'none') process.env.OASIS_PERMISSION_PROMPTS = 'none'; continue;
    }
    if (arg === '--autocompact') {
      // auto | off | PERCENT% (1-100) | a token window such as 500k or 1m (this session only).
      const value = String(rawArgs[++i] || '').trim().toLowerCase();
      const tokens = /^(\d+(?:\.\d+)?)\s*([km])$/.exec(value);
      if (value === 'auto') { delete process.env.OASIS_AUTOCOMPACT_PCT; continue; }
      if (value === 'off' || value === '0') { process.env.OASIS_AUTOCOMPACT_PCT = '0'; continue; }
      if (tokens || /^\d{5,}$/.test(value)) {
        const count = tokens ? Number(tokens[1]) * (tokens[2] === 'm' ? 1_000_000 : 1_000) : Number(value);
        process.env.OASIS_COMPACT_THRESHOLD_CHARS = String(Math.min(8_000_000, Math.max(10_000, Math.round(count * 4))));
        continue;
      }
      const pct = Number(value.replace(/%$/, ''));
      if (!(Number.isInteger(pct) && pct >= 1 && pct <= 100)) throw new Error('--autocompact takes auto, off, a percentage (70 or 70%), or a token count (500k, 1m).');
      process.env.OASIS_AUTOCOMPACT_PCT = String(pct);
      continue;
    }
    if (arg === '--append-system-prompt') { SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, rawArgs[++i] || ''].filter(Boolean).join('\n\n'); continue; }
    const needValue = (flag) => { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(flag + ' requires a value.'); i += 1; return value; };
    if (arg === '--system-prompt') { SESSION_OPTIONS.systemPromptOverride = needValue(arg); continue; }
    if (arg === '--output-style' || arg.startsWith('--output-style=')) { const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : needValue(arg); if (!String(value).trim()) throw new Error('--output-style requires a style name.'); SESSION_OPTIONS.outputStyle = String(value).trim(); continue; }
    if (arg === '--system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'system', file: needValue(arg) }); continue; }
    if (arg === '--append-system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'append', file: needValue(arg) }); continue; }
    if (arg === '--fallback-model') { SESSION_OPTIONS.fallbackModel = needValue(arg); continue; }
    if (arg === '--advisor') { SESSION_OPTIONS.advisor = needValue(arg); continue; }
    if (arg === '--chrome') { SESSION_OPTIONS.chrome = true; continue; }
    if (arg === '--no-chrome') { SESSION_OPTIONS.chrome = false; continue; }
    if (arg === '--bg' || arg === '--background') { SESSION_OPTIONS.background = true; continue; }
    if (arg === '--exec') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error('--exec requires a shell command.'); i += 1; SESSION_OPTIONS.exec = value; continue; }
    if (arg === '--max-budget-usd') {
      const value = Number(needValue(arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-budget-usd must be a positive dollar amount, for example 2.50.');
      SESSION_OPTIONS.maxBudgetUsd = value;
      continue;
    }
    // Zero-budget mode and request/token budgets live in the environment so
    // child agents (`oasis -p` subprocesses, best-of-N attempts) inherit them.
    if (arg === '--zero-budget') { process.env.OASIS_ZERO_BUDGET = '1'; continue; }
    if (arg === '--max-requests' || arg === '--max-total-tokens') {
      const value = Number(needValue(arg));
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(arg + ' must be a positive whole number.');
      process.env[arg === '--max-requests' ? 'OASIS_MAX_REQUESTS' : 'OASIS_MAX_TOTAL_TOKENS'] = String(value);
      continue;
    }
    if (arg === '--agent') { SESSION_OPTIONS.agent = needValue(arg).trim().toLowerCase(); continue; }
    if (arg === '--tools') { SESSION_OPTIONS.tools = needValue(arg).split(/[\s,]+/).filter(Boolean); continue; }
    if (arg === '--mcp-config') { SESSION_OPTIONS.pendingFiles.push({ kind: 'mcp', file: needValue(arg) }); continue; }
    if (arg === '--strict-mcp-config') { SESSION_OPTIONS.strictMcpConfig = true; continue; }
    if (arg === '--channels' || arg.startsWith('--channels=') || arg === '--dangerously-load-development-channels' || arg.startsWith('--dangerously-load-development-channels=')) {
      const dev = arg.startsWith('--dangerously');
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error(arg + ' needs a list like server:webhook or plugin:telegram@claude-plugins-official.');
      const { parseChannelEntries } = await import('./channels.mjs');
      const entries = parseChannelEntries(value);
      (dev ? SESSION_OPTIONS.devChannels : SESSION_OPTIONS.channels).push(...entries.map((entry) => entry.raw));
      continue;
    }
    if (arg === '--settings') { SESSION_OPTIONS.pendingFiles.push({ kind: 'settings', file: needValue(arg) }); continue; }
    if (arg === '--setting-sources') {
      const list = needValue(arg).split(/[\s,]+/).filter(Boolean);
      if (list.some((item) => !['user', 'project', 'local'].includes(item))) throw new Error('--setting-sources accepts user, project and local.');
      SESSION_OPTIONS.settingSources = list;
      continue;
    }
    if (arg === '--agents') { SESSION_OPTIONS.pendingFiles.push({ kind: 'agents', file: needValue(arg) }); continue; }
    if (arg === '--session-id') {
      const value = needValue(arg);
      if (!/^[a-f0-9-]{20,80}$/i.test(value)) throw new Error('--session-id must be a UUID.');
      SESSION_OPTIONS.sessionId = value.toLowerCase(); flags.persistSession = true; continue;
    }
    if (arg === '--fork-session') { SESSION_OPTIONS.forkSession = true; continue; }
    if (arg === '--name' || arg === '-n') { SESSION_OPTIONS.sessionName = needValue(arg); flags.persistSession = true; continue; }
    if (arg === '--verbose') { SESSION_OPTIONS.verbose = true; continue; }
    if (arg === '--debug-file') { SESSION_OPTIONS.debugFile = needValue(arg); process.env.OASIS_DEBUG_FILE = SESSION_OPTIONS.debugFile; if (!SESSION_OPTIONS.debug) { SESSION_OPTIONS.debug = 'all'; process.env.OASIS_DEBUG = 'all'; } continue; }
    if (arg === '--debug') { SESSION_OPTIONS.debug = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') && !/\s/.test(rawArgs[i + 1]) && /^[a-z,!]+$/i.test(rawArgs[i + 1]) ? rawArgs[++i] : 'all'; process.env.OASIS_DEBUG = SESSION_OPTIONS.debug; continue; }
    if (arg === '--disable-slash-commands') { SESSION_OPTIONS.disableSlashCommands = true; continue; }
    if (arg === '--input-format') {
      flags.headless.inputFormat = needValue(arg);
      if (!['text', 'stream-json'].includes(flags.headless.inputFormat)) throw new Error('--input-format must be text or stream-json.');
      continue;
    }
    if (arg === '--include-partial-messages') { flags.headless.includePartial = true; continue; }
    if (arg === '--replay-user-messages') { flags.headless.replayUser = true; continue; }
    if (arg === '--include-hook-events') { flags.headless.includeHookEvents = true; continue; }
    if (arg === '--forward-subagent-text') { flags.headless.forwardSubagentText = true; continue; }
    if (arg === '--prompt-suggestions') { flags.headless.promptSuggestions = true; continue; }
    if (arg === '--exclude-dynamic-system-prompt-sections') { SESSION_OPTIONS.excludeDynamicSections = true; continue; }
    if (arg === '--permission-prompt-tool') { flags.headless.permissionPromptTool = needValue(arg); continue; }
    if (arg === '--init' || arg === '--init-only') { SESSION_OPTIONS.runInit = arg === '--init-only' ? 'only' : 'continue'; continue; }
    if (arg === '--maintenance') { SESSION_OPTIONS.runMaintenance = true; continue; }
    if (arg === '--from-pr') { SESSION_OPTIONS.fromPr = needValue(arg); continue; }
    if (arg === '-p' || arg === '--print') {
      flags.headless.enabled = true;
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) flags.headless.prompt = rawArgs[++i];
      continue;
    }
    if (arg === '--output-format') {
      flags.headless.outputFormat = rawArgs[++i];
      if (!OUTPUT_FORMATS.includes(flags.headless.outputFormat)) throw new Error('--output-format must be one of ' + OUTPUT_FORMATS.join(', ') + '.');
      continue;
    }
    if (arg.startsWith('--output-format=')) { flags.headless.outputFormat = arg.slice(16); continue; }
    if (arg === '--goal') {
      if (!rawArgs[i + 1]) throw new Error('--goal requires a condition, e.g. --goal "npm test passes".');
      flags.headless.goal = String(rawArgs[++i]);
      if (flags.headless.goal.length > 4000) throw new Error('A goal can be at most 4,000 characters. Put the details in a file and point the goal at it.');
      flags.headless.enabled = true;
      continue;
    }
    if (arg === '--require-verified') { flags.headless.requireVerified = true; continue; }
    if (arg === '--goal-turns') {
      const value = Number.parseInt(rawArgs[++i], 10);
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('--goal-turns must be a whole number from 1 to 100.');
      flags.headless.goalMaxTurns = value;
      continue;
    }
    if (arg === '--max-turns') {
      const value = Number.parseInt(rawArgs[++i], 10);
      if (!Number.isInteger(value) || value < 1 || value > 400) throw new Error('--max-turns must be a whole number from 1 to 400.');
      flags.headless.maxTurns = value;
      continue;
    }
    if (arg === '--model') {
      if (!rawArgs[i + 1]) throw new Error('--model requires a model id.');
      SESSION_OPTIONS.model = rawArgs[++i];
      continue;
    }
    if (arg === '--effort') {
      const level = String(rawArgs[++i] || '').toLowerCase();
      if (!['low', 'medium', 'high', 'max', 'auto'].includes(level)) throw new Error('--effort must be low, medium, high, max or auto.');
      SESSION_OPTIONS.effort = level === 'auto' ? null : level;
      continue;
    }
    if (arg === '--json-schema' || arg === '--output-schema') {
      const value = rawArgs[++i];
      if (!value) throw new Error(arg + ' needs a JSON Schema (inline JSON or @path/to/schema.json).');
      // Codex's --output-schema takes a plain file path.
      flags.headless.jsonSchemaSource = arg === '--output-schema' && !/^\s*[{@]/.test(value) ? '@' + value : value;
      continue;
    }
    if (arg === '-o' || arg === '--output-last-message') {
      const value = rawArgs[++i];
      if (!value || value.startsWith('-')) throw new Error(arg + ' needs a file path for the final message.');
      flags.headless.outputLastMessage = value;
      continue;
    }
    if (arg === '-w' || arg === '--worktree') {
      flags.worktreeName = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : 'session';
      continue;
    }
    if (arg === '--plan') { flags.headless.planOnly = true; continue; }
    if (arg === '--tmux' || arg === '--tmux=classic') { SESSION_OPTIONS.tmux = true; continue; }
    if (arg === '--ide') { process.env.OASIS_IDE = 'auto'; continue; }
    if (arg === '--teammate-mode' || arg.startsWith('--teammate-mode=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!['auto', 'in-process', 'tmux'].includes(String(value))) throw new Error('--teammate-mode must be auto, in-process or tmux.');
      process.env.OASIS_TEAMMATE_MODE = value;
      continue;
    }
    if (arg === '--ax-screen-reader') { process.env.OASIS_AX_SCREEN_READER = '1'; continue; }
    if (arg === '--betas') {
      const values = [];
      while (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) values.push(...rawArgs[++i].split(','));
      if (!values.length) throw new Error('--betas needs one or more beta header names.');
      process.env.ANTHROPIC_BETAS = [process.env.ANTHROPIC_BETAS, ...values].filter(Boolean).join(',');
      continue;
    }
    if (arg === '--system-prompt-snapshot' || arg.startsWith('--system-prompt-snapshot=')) {
      const value = (arg.includes('=') ? arg.split('=')[1] : rawArgs[++i] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) throw new Error('--system-prompt-snapshot must be on or off.');
      SESSION_OPTIONS.systemPromptSnapshot = value;
      continue;
    }
    if (arg === '--plugin-url') { const url = rawArgs[++i]; if (!url) throw new Error('--plugin-url needs a URL.'); (SESSION_OPTIONS.pluginUrls ||= []).push(url); continue; }
    if (arg === '--plugin-dir') { const dir = rawArgs[++i]; if (!dir) throw new Error('--plugin-dir needs a directory.'); process.env.OASIS_PLUGIN_DIRS = [process.env.OASIS_PLUGIN_DIRS, path.resolve(dir)].filter(Boolean).join(path.delimiter); continue; }
    if (arg === '--add-dir') { const dir = rawArgs[++i]; if (!dir) throw new Error('--add-dir needs a directory.'); SESSION_OPTIONS.addDirs.push(path.resolve(dir)); continue; }
    if (arg === '--dangerously-skip-permissions') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; flags.autoApprove = true; continue; }
    // Codex and Gemini CLI flags, mapped to the nearest OASIS policy. The runtime's
    // hard refusals (home deletion, force pushes, reset --hard, ...) still apply.
    if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; flags.autoApprove = true; process.env.OASIS_SANDBOX = '0'; continue; }
    if (arg === '--full-auto') { SESSION_OPTIONS.permissionMode = 'acceptEdits'; process.env.OASIS_SANDBOX = '1'; continue; }
    if (arg === '--sandbox' || arg === '-s' || arg.startsWith('--sandbox=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      flags.headless.codexSandbox = value;
      if (value === 'read-only') SESSION_OPTIONS.permissionMode = 'plan';
      else if (value === 'workspace-write') process.env.OASIS_SANDBOX = '1';
      else if (value === 'danger-full-access') process.env.OASIS_SANDBOX = '0';
      else throw new Error('--sandbox must be read-only, workspace-write or danger-full-access.');
      continue;
    }
    if (arg === '--ask-for-approval' || arg === '-a' || arg.startsWith('--ask-for-approval=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      // never: no prompts, like Codex; OASIS uses auto mode, whose risk check still blocks dangerous commands.
      flags.headless.codexApproval = value;
      if (value === 'never') SESSION_OPTIONS.permissionMode = 'auto';
      else if (value === 'on-request' || value === 'on-failure' || value === 'untrusted') SESSION_OPTIONS.permissionMode = SESSION_OPTIONS.permissionMode || 'default';
      else throw new Error('--ask-for-approval must be untrusted, on-failure, on-request or never.');
      continue;
    }
    if (arg === '--approval-mode' || arg.startsWith('--approval-mode=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      const mode = { default: 'default', auto_edit: 'acceptEdits', 'auto-edit': 'acceptEdits', yolo: 'bypassPermissions', plan: 'plan' }[value];
      if (!mode) throw new Error('--approval-mode must be default, auto_edit, yolo or plan.');
      SESSION_OPTIONS.permissionMode = mode;
      if (mode === 'bypassPermissions') { SESSION_OPTIONS.allowBypass = true; flags.autoApprove = true; }
      continue;
    }
    if (arg === '--include-directories' || arg.startsWith('--include-directories=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--include-directories needs a comma-separated list of directories.');
      for (const dir of value.split(',').map((item) => item.trim()).filter(Boolean)) SESSION_OPTIONS.addDirs.push(path.resolve(dir));
      continue;
    }
    if (arg === '--skip-git-repo-check') continue;
    if (flags.execMode && (arg === '--json' || arg === '--experimental-json')) { flags.headless.codexJson = true; continue; }
    if (flags.execMode && (arg === '--config' || arg.startsWith('--config=') || (arg === '-c' && /^[\w.-]+=/.test(rawArgs[i + 1] || '')))) {
      const pair = arg.includes('=') && arg.startsWith('--config=') ? arg.slice('--config='.length) : rawArgs[++i];
      if (!pair || !pair.includes('=')) throw new Error('--config needs key=value.');
      (flags.headless.codexConfig ||= []).push(pair);
      continue;
    }
    if (arg === '--image' || (flags.execMode && arg === '-i') || arg.startsWith('--image=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--image needs a file path.');
      for (const file of value.split(',').map((item) => item.trim()).filter(Boolean)) (flags.headless.images ||= []).push(path.resolve(file));
      continue;
    }
    if (flags.execMode && (arg === '--thread-source' || arg === '--color')) { i++; continue; }
    if (flags.execMode && arg === '--ephemeral') { flags.noPersist = true; continue; }
    if (flags.execMode && arg === 'resume' && !flags.args.length) {
      // The Codex SDK puts `resume THREAD_ID` after the flags.
      const next = rawArgs[i + 1];
      if (next === '--last') { i++; flags.persistSession = true; flags.continueSession = true; }
      else if (next && !next.startsWith('-')) { flags.resumeId = rawArgs[++i]; flags.persistSession = true; }
      continue;
    }
    // Gemini CLI: start the interactive session with this first message.
    if (arg === '-i' || arg === '--prompt-interactive' || arg.startsWith('--prompt-interactive=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--prompt-interactive needs a message.');
      SESSION_OPTIONS.initialPrompt = value; continue;
    }
    // Aider flags. --test-cmd plus --auto-test uses Oasis auto-test; commits use auto-commit.
    if (arg === '--yes-always') { flags.autoApprove = true; continue; }
    if (arg === '--message' || arg === '--msg' || arg.startsWith('--message=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error(arg.split('=')[0] + ' needs a message.');
      flags.headless.enabled = true; flags.headless.prompt = value; continue;
    }
    if (arg === '--message-file' || arg.startsWith('--message-file=')) {
      const file = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!file) throw new Error('--message-file needs a file.');
      flags.headless.enabled = true; flags.headless.prompt = readFileSync(path.resolve(file), 'utf8'); continue;
    }
    if (arg === '--test-cmd' || arg.startsWith('--test-cmd=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--test-cmd needs a command.');
      SESSION_OPTIONS.aiderTestCmd = value; continue;
    }
    if (arg === '--auto-test') { SESSION_OPTIONS.aiderAutoTest = true; continue; }
    if (arg === '--no-auto-test') { process.env.OASIS_AUTO_TEST = 'off'; continue; }
    if (arg === '--auto-commits') { process.env.OASIS_AUTO_COMMIT = '1'; continue; }
    if (arg === '--no-auto-commits') { process.env.OASIS_AUTO_COMMIT = '0'; continue; }
    if (arg === '--no-session-persistence') { flags.noPersist = true; continue; }
    if (arg === '--continue' || arg === '-c') { flags.persistSession = true; flags.continueSession = true; continue; }
    if (arg === '--resume' || arg === '-r') {
      // Without an ID (like `claude -r`), open the session picker.
      if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith('-')) { SESSION_OPTIONS.resumePicker = true; flags.persistSession = true; continue; }
      flags.resumeId = rawArgs[++i]; flags.persistSession = true; continue;
    }
    if (arg === '--workspace' || arg === '-C' || arg === '--cd') {
      if (!rawArgs[i + 1]) throw new Error('--workspace requires a path.');
      flags.workspace = path.resolve(rawArgs[++i]);
      continue;
    }
    if (arg.startsWith('--workspace=')) { flags.workspace = path.resolve(arg.slice('--workspace='.length)); continue; }
    flags.args.push(arg);
  }
}

async function main() {
  // HTTPS_PROXY / HTTP_PROXY / NO_PROXY for every outbound request (Node's fetch ignores them).
  installProxyFromEnv();
  const rawArgs = process.argv.slice(2);
  // --profile NAME (or -P NAME) picks an isolated agent profile before anything reads config.
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--') break;
    if (arg === '--profile' || arg === '-P' || arg.startsWith('--profile=')) {
      const name = arg.startsWith('--profile=') ? arg.slice(10) : rawArgs[i + 1];
      if (!name) throw new Error('--profile needs a name.');
      process.env.OASIS_PROFILE = name;
      rawArgs.splice(i, arg.startsWith('--profile=') ? 1 : 2);
      i--;
    }
  }
  // Routines parse their own flags (--name, --model, --permission-mode mean routine fields here).
  if (['schedule', 'cron', 'routines'].includes(rawArgs[0])) {
    if (process.env.OASIS_PROFILE) { const { activeProfile } = await import('./config.mjs'); activeProfile(process.env); }
    const { scheduleCommand } = await import('./cli-routines.mjs');
    await scheduleCommand(rawArgs.slice(1), { env: process.env });
    return;
  }
  // Cloud agents parse their own flags (--model, --here, --pr).
  if (rawArgs[0] === 'cloud') {
    const { cloudCommand } = await import('./cloud.mjs');
    try { process.exitCode = await cloudCommand(rawArgs.slice(1), { env: process.env }); }
    catch (error) { process.stderr.write('oasis cloud: ' + error.message + '\n'); process.exitCode = 1; }
    return;
  }
  if (rawArgs[0] === 'deploy') {
    const { deployCommand } = await import('./deploy.mjs');
    try { process.exitCode = await deployCommand(rawArgs.slice(1), { env: process.env }); }
    catch (error) { process.stderr.write('oasis deploy: ' + error.message + '\n'); process.exitCode = 1; }
    return;
  }
  // `oasis diff [--watch]`: uncommitted changes, optionally as a live full-screen view.
  if (rawArgs[0] === 'diff') {
    const { diffCommand } = await import('./live-diff.mjs');
    try { process.exitCode = await diffCommand(rawArgs.slice(1), { env: process.env }); }
    catch (error) { process.stderr.write('oasis diff: ' + error.message + '\n'); process.exitCode = 1; }
    return;
  }
  if (subcommandHelp(rawArgs)) return;
  if (process.env.OASIS_PROFILE) { const { activeProfile } = await import('./config.mjs'); activeProfile(process.env); }
  if (rawArgs[0] === 'completion' || rawArgs[0] === 'completions') {
    const { completionScript, completionUsage } = await import('./shell-completion.mjs');
    const script = rawArgs[1] ? completionScript(rawArgs[1]) : null;
    if (!script) { (rawArgs[1] ? process.stderr : stdout).write((rawArgs[1] ? 'Unknown shell: ' + rawArgs[1] + '\n\n' : '') + completionUsage()); if (rawArgs[1]) process.exitCode = 1; return; }
    stdout.write(script);
    return;
  }
  if (rawArgs[0] === 'profile' || rawArgs[0] === 'profiles') {
    const { profileCommand } = await import('./profiles.mjs');
    await profileCommand(rawArgs.slice(1));
    return;
  }
  // `oasis exec PROMPT` is an alias for `oasis -p PROMPT` (Codex CLI muscle memory).
  // `oasis exec --json` / `--experimental-json` streams Codex exec JSONL events, so
  // the Codex SDK can run OASIS (codexPathOverride). `exec resume ID|--last` continues.
  let execMode = false;
  if (rawArgs[0] === 'exec') {
    execMode = true;
    rawArgs[0] = '-p';
    if (rawArgs[1] === 'resume') {
      if (rawArgs[2] === '--last') rawArgs.splice(1, 2, '-c');
      else if (rawArgs[2] && !rawArgs[2].startsWith('-')) rawArgs.splice(1, 2, '-r', rawArgs[2]);
      else rawArgs.splice(1, 1);
    }
  }
  // `oasis resume [--last | ID]` (Codex CLI) maps to -c / -r.
  if (rawArgs[0] === 'resume' && (rawArgs.length === 1 || rawArgs[1] === '--last' || /^[0-9a-f][0-9a-f-]{6,}$/i.test(rawArgs[1] || '') || String(rawArgs[1] || '').startsWith('-'))) {
    if (rawArgs[1] === '--last') rawArgs.splice(0, 2, '-c'); else rawArgs[0] = '-r';
  }
  let autoApprove = process.env.OASIS_AUTO_APPROVE === '1';
  if (process.env.CLAUDE_CODE_SAFE_MODE === '1' || process.env.OASIS_SAFE_MODE === '1') { SESSION_OPTIONS.safeMode = true; process.env.OASIS_SAFE_MODE = '1'; }
  // Sessions are saved by default (resume with -c / -r / /resume), like Claude Code.
  let persistSession = process.env.OASIS_PERSIST_SESSIONS !== '0';
  let noPersist = process.env.OASIS_PERSIST_SESSIONS === '0';
  let continueSession = false;
  let resumeId = null;
  let workspace = process.cwd();
  let worktreeName = null;
  const args = [];
  let explicitYes = false;
  const headless = { enabled: false, prompt: '', outputFormat: 'text', maxTurns: null, planOnly: false };
  const flags = { execMode, autoApprove, persistSession, noPersist, continueSession, resumeId, workspace, worktreeName, args, explicitYes, headless };
  await parseMainFlags(rawArgs, flags);
  ({ autoApprove, persistSession, noPersist, continueSession, resumeId, workspace, worktreeName, explicitYes } = flags);
  if (SESSION_OPTIONS.aiderAutoTest) {
    // Aider runs --test-cmd only with --auto-test; without --test-cmd, keep the configured command.
    if (SESSION_OPTIONS.aiderTestCmd && process.env.OASIS_AUTO_TEST !== 'off') process.env.OASIS_AUTO_TEST = SESSION_OPTIONS.aiderTestCmd;
  }
  try { await access(workspace); }
  catch { throw new Error('The workspace folder does not exist or is not accessible: ' + workspace + ' (check -C / --workspace).'); }
  await resolveFlagFiles(workspace);
  if (SESSION_OPTIONS.pluginUrls && SESSION_OPTIONS.pluginUrls.length) {
    const { fetchPluginArchive } = await import('./zip.mjs');
    for (const url of SESSION_OPTIONS.pluginUrls) {
      const dir = await fetchPluginArchive(url);
      // fetchPluginArchive may return the plugin's single top-level subfolder;
      // register its actual temporary extraction root so cleanup removes the parent too.
      const parent = path.dirname(dir);
      TEMPORARY_PLUGIN_DIRS.add(path.basename(parent).startsWith('oasis-plugin-url-') ? parent : dir);
      process.env.OASIS_PLUGIN_DIRS = [process.env.OASIS_PLUGIN_DIRS, dir].filter(Boolean).join(path.delimiter);
    }
  }
  if (SESSION_OPTIONS.restricted && (SESSION_OPTIONS.permissionMode === 'bypassPermissions' || SESSION_OPTIONS.allowBypass)) throw new Error('--restricted cannot be combined with --dangerously-skip-permissions, --allow-dangerously-skip-permissions, or --permission-mode bypassPermissions.');
  if (SESSION_OPTIONS.restricted) { autoApprove = false; SESSION_OPTIONS.allowBypass = false; }
  if (SESSION_OPTIONS.runInit) {
    await initWorkspace(workspace);
    await runSetupHooks(workspace, 'init');
    if (SESSION_OPTIONS.runInit === 'only') return;
  }
  if (SESSION_OPTIONS.runMaintenance) await runSetupHooks(workspace, 'maintenance');
  // `oasis -- "-x is broken"` sends text that starts with a dash as the task.
  if (args[0] === '--') args.shift();
  else if (args[0] && !['--interactive', '--help', '-h', '--version', '-v'].includes(args[0])) {
    const message = unknownOptionMessage(args[0]);
    if (message) throw new Error(message);
  }
  const command = args[0];
  const rest = args.slice(1);
  // The Claude Agent SDK (0.3.x) launches the CLI with stream-json in and out but no -p.
  if (!headless.enabled && headless.inputFormat === 'stream-json' && headless.outputFormat === 'stream-json') headless.enabled = true;
  const persistence = { enabled: !noPersist && (persistSession || Boolean(resumeId)), resumeId };
  if (continueSession && !resumeId) {
    const saved = (await listSessions(workspace)).filter((item) => !item.archived);
    persistence.resumeId = saved[0] && saved[0].id || null;
    if (!persistence.resumeId) (headless.enabled ? stderr : stdout).write('No previous session exists for this workspace; a new session will be saved after your next task.\n');
  }

  if (headless.jsonSchemaSource) {
    const source = headless.jsonSchemaSource.startsWith('@') ? await readFile(path.resolve(headless.jsonSchemaSource.slice(1)), 'utf8') : headless.jsonSchemaSource;
    try { headless.jsonSchema = JSON.parse(source); } catch (error) { throw new Error('--json-schema is not valid JSON: ' + error.message); }
    if (!headless.jsonSchema || typeof headless.jsonSchema !== 'object') throw new Error('--json-schema must be a JSON object.');
    if (!headless.enabled) throw new Error('--json-schema works with -p (headless mode).');
  }
  await applySettingsPolicy(workspace, autoApprove, [persistence && persistence.resumeId, SESSION_OPTIONS.sessionId]);
  if (SESSION_OPTIONS.exec !== undefined) {
    if (SESSION_OPTIONS.restricted) throw new Error('--exec is not available in --restricted mode.');
    const { startExecJob } = await import('./background-sessions.mjs');
    const entry = await startExecJob({ root: workspace, command: [SESSION_OPTIONS.exec, ...args].join(' '), env: process.env, name: SESSION_OPTIONS.sessionName || null });
    stdout.write('Started background job ' + entry.id + ': ' + entry.command + '\n  oasis logs ' + entry.id + ' --follow   watch output\n  oasis stop ' + entry.id + '             stop it\n');
    if (!SESSION_OPTIONS.background && stdout.isTTY) return await backgroundCommand(['logs', entry.id, '--follow'], { approve, interactive });
    return;
  }
  if (SESSION_OPTIONS.background) {
    const task = args.join(' ').trim();
    if (!task) throw new Error('Usage: oasis --bg "describe the task"');
    const { startBackgroundSession } = await import('./background-sessions.mjs');
    const entry = await startBackgroundSession({ root: workspace, prompt: task, env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null, model: SESSION_OPTIONS.model || null, name: SESSION_OPTIONS.sessionName || null });
    stdout.write('Started background session ' + entry.id + '. It runs without approval prompts, so only tools your permission rules allow will run.\n  oasis bg logs ' + entry.id + ' --follow   watch progress\n  oasis bg attach ' + entry.id + '          continue the conversation here\n');
    return;
  }
  if (SESSION_OPTIONS.tmux && !worktreeName) throw new Error('--tmux requires --worktree.');
  if (SESSION_OPTIONS.resumePicker) {
    if (headless.enabled) throw new Error('--resume requires a saved session ID with -p.');
    QUEUED_INPUT.unshift('/resume');
  }
  if (SESSION_OPTIONS.initialPrompt && !headless.enabled) {
    if (command && command !== '--interactive') throw new Error('--prompt-interactive takes the whole first message; quote it, for example oasis -i "fix the tests".');
    QUEUED_INPUT.push(SESSION_OPTIONS.initialPrompt);
  }
  if (worktreeName && SESSION_OPTIONS.tmux && !headless.enabled && (!command || command === '--interactive')) return await tmuxWorktreeSession(workspace, worktreeName, rawArgs);
  if (worktreeName && (headless.enabled || !command || command === '--interactive')) {
    const session = await startSessionWorktree(workspace, worktreeName, headless.enabled ? stderr : stdout);
    try {
      if (headless.enabled) return await printMode(session.path, headless, args, autoApprove, persistence);
      return await interactive(session.path, autoApprove, persistence);
    } finally { await endSessionWorktree(workspace, session, headless.enabled ? stderr : stdout); }
  }
  if (headless.enabled) return await printMode(workspace, headless, args, autoApprove, persistence);
  if (!command || command === '--interactive') return await interactive(workspace, autoApprove, persistence);
  if (command === '--help' || command === '-h' || command === 'help') return (args.includes('all') || args.includes('--all')) ? printHelp() : printQuickHelp();
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(await readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
    stdout.write('OASIS ' + pkg.version + '\n');
    return;
  }
  if (command === 'setup') {
    if (rest.includes('--help') || rest.includes('-h')) {
      stdout.write([
        'Usage: oasis setup            Paste a key, model link or server address (Enter opens the step-by-step menu)',
        '       oasis setup --auto     Detect this computer and running model servers, then configure the best fit',
        '       oasis setup --auto --dry-run   Show what --auto would choose without saving',
        '',
        'Setup saves a provider only after a real test request succeeds. To connect',
        'without the wizard, use oasis connect KEY|LINK|ADDRESS or oasis connect --from-env.',
        ''
      ].join('\n'));
      return;
    }
    // `oasis setup --auto` (or `setup auto` / `--detect`): configure from this computer's hardware and running model servers.
    if (rest[0] === 'auto' || rest.includes('--detect') || process.argv.slice(2).includes('--auto')) return await autoSetup(workspace, { dryRun: rest.includes('--dry-run') });
    if (stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && !rest.length) {
      const outcome = await pasteFirstSetup(workspace);
      if (outcome !== 'menu') return;
    }
    return await configureProvider(workspace);
  }
  if (command === 'connect') return await connectCommand(rest, workspace);
  if (command === 'models') {
    const { modelsCommand } = await import('./models-command.mjs');
    process.exitCode = await modelsCommand(rest, { root: workspace });
    return;
  }
  if (command === 'doctor') return await doctor(rest, workspace, { fallbackModel: SESSION_OPTIONS.fallbackModel });
  if (command === 'memory') return await memoryCommand(rest, workspace);
  if (command === 'diagnostics') return await diagnosticsCommand(rest, workspace, autoApprove);
  // The global flag parser takes --yes/-y for autoApprove; hand it back.
  if (command === 'update') return await updateOasis(explicitYes && !rest.includes('--yes') ? [...rest, '--yes'] : rest, { ask: askLine });
  if (command === 'uninstall') return await uninstallOasis(explicitYes && !rest.includes('--yes') ? [...rest, '--yes'] : rest, { ask: askLine });
  if (command === 'web') return await startWebWorkspace(workspace, rest);
  if (command === 'app') throw new Error('The standalone browser app has been removed. Use "oasis web --open" for a normal connected session.');
  if (command === 'watch') return await watchCommentsCommand(workspace, autoApprove || rest.includes('--yes'), persistence);
  if (command === 'plan') {
    const planPrompt = rest.join(' ').trim();
    if (!planPrompt) throw new Error('Usage: oasis plan "Describe the task to plan"');
    await ensureModelProviderSetup(workspace);
    const session = await runPrompt(planPrompt, workspace, autoApprove, null, persistence, { planOnly: true });
    closeSession(session);
    return;
  }
  if (command === 'eval') {
    // The global option parser above consumes --model before `eval` sees it.
    // Hand it back: external agents take it as their own --model; OASIS's own
    // eval reads the model from its provider config (OASIS_MODEL).
    const { args: evalArgs, env: evalEnv } = evalModelPassthrough(rest, SESSION_OPTIONS.model, process.env);
    const result = await runEvalCommand(evalArgs, { autoApprove, env: evalEnv });
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === 'init') return await initWorkspace(workspace);
  if (command === 'update' || command === 'self-update') return await selfUpdate(autoApprove);
  if (command === 'config' || command === 'status') return printConfig(await loadConfig());
  if (command === 'mcp') return await manageMcp(rest, workspace, { approve, askLine: (question) => askLine(question), askSecret: stdin.isTTY ? (question) => askSecret(question) : null });
  // A pasted install command (npx …, uvx …, claude mcp add …, /plugin install …,
  // npx skills add …) is one source too, quoted or not.
  const ADD_USAGE = 'Usage: oasis add <GitHub link | owner/repo[#name] | plugin@marketplace | MCP URL | npm package | registry name> [--project] [--name NAME]\n';
  if (command === 'add' && (!rest.some((word) => !/^-/.test(word)) || rest[0] === '--help' || rest[0] === '-h')) {
    // Without a source (or with --help) this is a usage question, not a task for the agent.
    stdout.write(ADD_USAGE);
    if (!rest.includes('--help') && !rest.includes('-h')) process.exitCode = 1;
    return;
  }
  const pastedInstall = command === 'add' && /^(npx|uvx|bunx|pnpx|docker|pipx|claude|codex|gemini|qwen|opencode|skills|\/plugin)$/i.test(String(rest[0] || '')) && rest.length > 1;
  if (pastedInstall) {
    const { addAnything } = await import('./add-anything.mjs');
    // Read the command from the raw arguments: its own flags (npx -y, -e KEY=V,
    // --transport) belong to it, and its -y must not count as OASIS's --yes.
    const argv = process.argv.slice(2);
    const at = argv.indexOf('add');
    const tail = argv.slice(at + 1);
    const yes = argv.slice(0, at).some((arg) => arg === '--yes' || arg === '-y') || tail[tail.length - 1] === '--yes';
    const source = (tail[tail.length - 1] === '--yes' ? tail.slice(0, -1) : tail).map((word) => /[\s"'\\]/.test(word) ? "'" + word.replace(/'/g, "'\\''") + "'" : word).join(' ');
    stdout.write('Looking at ' + source + '…\n');
    const result = await addAnything(source, { root: workspace, env: process.env, scope: 'user', approve: async (summary) => {
      stdout.write(summary + '\n');
      if (yes) return true;
      if (!stdin.isTTY) { stdout.write('Run again with --yes to install without a prompt.\n'); return false; }
      return /^y(es)?$/i.test(String(await askLine('Install it? [y/N] ')).trim());
    } });
    stdout.write(result.message + '\n');
    if (result.approved === false) process.exitCode = 1;
    return result;
  }
  if (command === 'add' && rest.filter((word) => !/^--/.test(word)).length - (rest.includes('--name') ? 1 : 0) === 1) {
    // oasis add <anything>: GitHub link, owner/repo, plugin@marketplace, MCP URL,
    // npm MCP package or MCP Registry name. One summary, one yes, done.
    const { addAnything } = await import('./add-anything.mjs');
    const words = rest.filter((word) => !/^--/.test(word));
    const scope = rest.includes('--project') ? 'project' : 'user';
    const nameAt = rest.indexOf('--name');
    const name = nameAt >= 0 ? rest[nameAt + 1] : undefined;
    const source = words.filter((word) => word !== name).join(' ');
    if (!source) { stdout.write(ADD_USAGE); process.exitCode = 1; return; }
    stdout.write('Looking at ' + source + '…\n');
    const result = await addAnything(source, { root: workspace, env: process.env, scope, name, approve: async (summary) => {
      stdout.write(summary + '\n');
      if (autoApprove) return true;
      if (!stdin.isTTY) { stdout.write('Run again with --yes to install without a prompt.\n'); return false; }
      return /^y(es)?$/i.test(String(await askLine('Install it? [y/N] ')).trim());
    } });
    stdout.write(result.message + '\n');
    if (result.approved === false) process.exitCode = 1;
    return result;
  }
  if (command === 'ide') { const { ideCli } = await import('./ide.mjs'); return await ideCli(workspace, rest, { env: process.env }); }
  if (command === 'extensions' || command === 'extension') return await manageExternalExtensions(workspace, rest, autoApprove, { approve });
  if (command === 'plugins' || command === 'plugin') {
    // Claude Code plugins and marketplaces; the bundled capability catalog stays under
    // `oasis plugins list|install|remove NAME` for its built-in names.
    const sub = String(rest[0] || 'list').toLowerCase();
    if (sub === 'eval') {
      const { pluginEvalCli } = await import('./plugin-eval.mjs');
      const result = await pluginEvalCli(rest.slice(1), { env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
      if (!result.ok || (result.report && result.report.summary.passRate < 1)) process.exitCode = 1;
      return;
    }
    const builtIn = ['install', 'remove'].includes(sub) && rest[1] && !String(rest[1]).includes('@') && await (await import('./plugins.mjs')).isBuiltInPlugin(rest[1]);
    if (sub === 'catalog' || sub === 'browse' || builtIn) return await managePlugins(workspace, sub === 'catalog' ? ['list', ...rest.slice(1)] : rest);
    const { pluginCli } = await import('./claude-plugins.mjs');
    if (sub === 'list' || sub === 'ls') {
      await managePlugins(workspace, ['list']);
      stdout.write('\nClaude Code plugins (oasis plugin marketplace add OWNER/REPO, then oasis plugin install NAME@MARKETPLACE)\n\n');
    }
    await pluginCli(workspace, rest, { env: process.env });
    return;
  }
  if (command === 'sessions') return await manageSessions(workspace, rest, { approve });
  if (command === 'quota') {
    const { listRoutes, resetLedger, formatQuotaReport, ledgerPath, ledgerEnabled } = await import('./quota-ledger.mjs');
    if (rest.includes('--help') || rest.includes('-h')) { stdout.write('Usage: oasis quota [--json] [--reset [TEXT]]\n  Shows model usage today per provider, key and model, the limits providers last reported, and cooldowns.\n  --reset clears every record, or those whose provider, key fingerprint or model contains TEXT.\n  Stored in ' + ledgerPath(process.env) + '. OASIS_QUOTA_LEDGER=off turns recording off.\n'); return; }
    const resetAt = rest.indexOf('--reset');
    if (resetAt >= 0) {
      const match = rest[resetAt + 1] && !rest[resetAt + 1].startsWith('--') ? rest[resetAt + 1] : '';
      const removed = resetLedger(process.env, match);
      stdout.write('Cleared ' + removed + ' quota record' + (removed === 1 ? '' : 's') + '.\n');
      return;
    }
    const routes = listRoutes(process.env);
    if (rest.includes('--json')) { stdout.write(JSON.stringify({ enabled: ledgerEnabled(process.env), file: ledgerPath(process.env), routes }, null, 2) + '\n'); return; }
    if (!ledgerEnabled(process.env)) stdout.write('Recording is off (OASIS_QUOTA_LEDGER=off).\n');
    stdout.write(formatQuotaReport(routes));
    return;
  }
  if (command === 'attempts' || command === 'best-of-n') {
    const { parseAttemptsArgs, attemptsUsage, runBestOfN, formatAttemptsReport } = await import('./best-of-n.mjs');
    const options = parseAttemptsArgs(rest);
    if (options.help) { stdout.write(attemptsUsage() + '\n'); return; }
    // --model, --max-turns and --permission-mode are global flags; carry them into every attempt.
    if (SESSION_OPTIONS.permissionMode) options.permissionMode = SESSION_OPTIONS.permissionMode;
    if (!options.models.length && SESSION_OPTIONS.model) options.models = [SESSION_OPTIONS.model];
    if (!options.maxTurns && headless.maxTurns) options.maxTurns = headless.maxTurns;
    const log = (line) => { if (!options.json) process.stderr.write(line + '\n'); };
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    try {
      const outcome = await runBestOfN(workspace, options, {
        env: process.env, signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'start') log('[attempts] Running ' + event.attempts + ' attempts in separate worktrees' + (event.dirty ? ' (from HEAD; your uncommitted changes are not included)' : '') + '.');
          else if (event.type === 'attempt_started') log('[attempts] #' + event.index + ' started' + (event.model ? ' with ' + event.model : '') + ' in ' + event.worktree);
          else if (event.type === 'attempt_finished') log('[attempts] #' + event.index + ' finished' + (event.record.error ? ' with an error' : event.record.verify ? (event.record.verify.passed ? ', check passed' : ', check failed') : ''));
        }
      });
      stdout.write(options.json ? JSON.stringify(outcome.report) + '\n' : formatAttemptsReport(outcome, options));
      if (options.verify && !outcome.winner) process.exitCode = 1;
      if (outcome.applied && outcome.applied.error) process.exitCode = 1;
    } finally { process.removeListener('SIGINT', onSigint); }
    return;
  }
  if (command === 'batch') {
    const { runBatch } = await import('./trajectories.mjs');
    const result = await runBatch(workspace, rest, { env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'gateway') {
    const { runGateway } = await import('./gateway-telegram.mjs');
    let scheduler = null;
    // Host routines only for a real gateway; a usage error must still exit.
    if (['telegram', 'discord', 'slack'].includes(String(rest[0] || '').toLowerCase())) {
      try {
        const { hostScheduler } = await import('./routines.mjs');
        scheduler = await hostScheduler({ env: process.env, log: (line) => stderr.write('[routines] ' + line + '\n') });
        if (!scheduler.hosted && process.env.OASIS_DEBUG) stderr.write('[routines] not hosted: ' + scheduler.reason + '\n');
      } catch (error) { stderr.write('Routines are not running: ' + error.message + '\n'); }
    }
    try { await runGateway(rest, { root: workspace, env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null }); }
    finally { if (scheduler) await scheduler.stop().catch(() => {}); }
    return;
  }
  if (command === 'app-server') {
    const { serveCodexAppServer } = await import('./codex-app-server.mjs');
    const { oasisVersion } = await import('./version.mjs');
    const flag = (name) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
    const listen = flag('--listen') || 'stdio://';
    const modeAt = rest.indexOf('--permission-mode');
    const permissionMode = (modeAt >= 0 ? rest[modeAt + 1] : null) || SESSION_OPTIONS.permissionMode || null;
    if (permissionMode && !['default', 'acceptEdits', 'plan', 'auto'].includes(permissionMode)) throw new Error('oasis app-server --permission-mode must be default, acceptEdits, plan or auto.');
    const { parseListenUrl, loadWsAuth, startCodexAppServerWebSocket, appServerListenNotice } = await import('./codex-app-server-ws.mjs');
    const target = parseListenUrl(listen);
    const authFlags = { mode: flag('--ws-auth'), tokenFile: flag('--ws-token-file'), tokenSha256: flag('--ws-token-sha256'), sharedSecretFile: flag('--ws-shared-secret-file'), issuer: flag('--ws-issuer'), audience: flag('--ws-audience'), maxClockSkewSeconds: flag('--ws-max-clock-skew-seconds') };
    if (target.transport === 'stdio' || target.transport === 'unix') {
      if (Object.values(authFlags).some((value) => value !== undefined)) throw new Error('--ws-auth flags only apply to --listen ws://IP:PORT; a unix:// socket is private to this user.');
    }
    if (target.transport === 'stdio') {
      await serveCodexAppServer({ env: process.env, version: oasisVersion(), permissionMode });
      return;
    }
    const verify = target.transport === 'unix' ? null : await loadWsAuth(authFlags);
    const listener = await startCodexAppServerWebSocket({ ...(target.transport === 'unix' ? { socketPath: target.socketPath } : { host: target.host, port: target.port }), verify, env: process.env, version: oasisVersion(), permissionMode });
    process.stderr.write(appServerListenNotice(listener.url, target.transport, Boolean(verify)));
    await new Promise((resolve) => { const stop = () => resolve(); process.once('SIGINT', stop); process.once('SIGTERM', stop); });
    await listener.close();
    return;
  }
  if (command === 'acp') {
    const { serveAcp } = await import('./acp.mjs');
    const { oasisVersion } = await import('./version.mjs');
    const modeAt = rest.indexOf('--permission-mode');
    const permissionMode = (modeAt >= 0 ? rest[modeAt + 1] : null) || SESSION_OPTIONS.permissionMode || null;
    if (permissionMode && !['default', 'acceptEdits', 'plan', 'auto'].includes(permissionMode)) throw new Error('oasis acp --permission-mode must be default, acceptEdits, plan or auto.');
    await serveAcp({ env: process.env, version: oasisVersion(), permissionMode, editorTerminal: rest.includes('--editor-terminal') });
    return;
  }
  if (command === 'skills' && rest[0] === 'eval') {
    const { pluginEvalCli } = await import('./plugin-eval.mjs');
    const result = await pluginEvalCli(rest.slice(1), { env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
    if (!result.ok || (result.report && result.report.summary.passRate < 1)) process.exitCode = 1;
    return;
  }
  if (command === 'skills') return await manageSkills(workspace, rest, autoApprove);
  if (command === 'permissions') return await managePermissions(workspace, rest);
  if (command === 'trust') return await manageTrust(workspace, rest);
  if (command === 'import') return await importCommand(workspace, rest, autoApprove);
  if (command === 'bg' || command === 'background') return await backgroundCommand(rest, { approve, interactive });
  // Claude Code's top-level background commands: claude attach|logs|stop|kill|rm|respawn ID.
  if (['attach', 'logs', 'stop', 'kill', 'rm', 'respawn'].includes(command)) return await backgroundCommand([command, ...rest], { approve, interactive });
  if (command === 'purge') return await purgeCommand(workspace, rest, autoApprove);
  if (command === 'auto-mode') return await autoModeCommand(workspace, rest, autoApprove);
  if (command === 'auth') return await authCommand(workspace, rest);
  if (command === 'setup-token') return await setupTokenCommand(rest);
  if (command === 'agents' && (rest.includes('--json') || !stdin.isTTY)) return await agentsCommand(rest);
  if (command === 'ultrareview') return await ultrareviewCommand(workspace, rest, autoApprove, persistence);
  if (command === 'insights') {
    const { writeInsightsReport, insightsSummaryText } = await import('./insights.mjs');
    const { file, stats } = await writeInsightsReport({ env: process.env, days: Math.min(365, Math.max(1, parseInt(rest[0], 10) || 30)) });
    stdout.write(insightsSummaryText(stats) + '\nReport: ' + file + '\n');
    return;
  }
  if (command === 'backups') return await showBackups(workspace);
  if (command === 'restore') return await restoreOne(workspace, rest[0]);
  if (command === 'install') {
    if (!rest.length) { stdout.write('Usage: oasis install PACKAGE_NAME  (or specify an ecosystem such as "npm package prettier")\n'); return; }
    const request = parseInstallIntent(args.join(' '));
    if (!request) throw new Error('Use one package name at a time. For compound setup requests, configure a provider and ask Oasis in plain English.');
    return await installRequest(request, workspace, autoApprove);
  }
  const fullPrompt = args.join(' ');
  {
    const direct = parseInstallIntent(fullPrompt);
    if (direct) return await installRequest(direct, workspace, autoApprove);
  }
  // On a terminal, a task given on the command line opens an interactive session so you
  // can follow up. Scripts (no TTY) and OASIS_ONE_SHOT=1 keep the one-shot run; -p is headless.
  if (stdin.isTTY && stdout.isTTY && !/^(?:1|true|yes|on)$/i.test(String(process.env.OASIS_ONE_SHOT || ''))) {
    QUEUED_INPUT.push(fullPrompt);
    return await interactive(workspace, autoApprove, persistence);
  }
  await ensureModelProviderSetup(workspace);
  const session = await runPrompt(fullPrompt, workspace, autoApprove, null, persistence);
  // No session means the prompt never ran (no provider configured); scripts
  // must see that as a failure, not a silent success.
  if (!session) process.exitCode = 1;
  closeSession(session);
}

// Run only as the entry point (`oasis`, `node src/cli.mjs`). Tests import
// helpers from this file; that import must not start an interactive session.
function isEntryPoint() {
  if (globalThis.__OASIS_CLI_ENTRY) return true;
  try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  main().catch((error) => {
    stderr.write('OASIS error: ' + (error.message || String(error)) + '\n');
    process.exitCode = 1;
  });
}
