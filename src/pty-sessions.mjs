// A real pseudo-terminal session manager for interactive workspace commands.
// node-pty is loaded only when the first interactive session is requested so a
// missing native binding never prevents OASIS's normal CLI from starting.
import { randomBytes } from 'node:crypto';
import { signalProcessTree } from './process-tree.mjs';

const MAX_ACTIVE_SESSIONS = 8;
const MAX_RETAINED_SESSIONS = 32;
const DEFAULT_BUFFER_CHARS = 256 * 1024;
const MAX_READ_CHARS = 48 * 1024;
const MAX_INPUT_CHARS = 16 * 1024;

function safeInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function statusOf(record) {
  return {
    id: record.id,
    command: record.display,
    state: record.state,
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    outputOffset: record.outputBase + record.output.length,
    ...(record.exitCode === null ? {} : { exitCode: record.exitCode }),
    ...(record.signal === null ? {} : { signal: record.signal }),
    ...(record.sandboxed ? { sandboxed: record.sandboxed } : {})
  };
}

export class PtySessionManager {
  constructor({ loadPty = () => import('node-pty'), maxSessions = MAX_ACTIVE_SESSIONS, bufferLimit = DEFAULT_BUFFER_CHARS, idFactory, killGraceMs = 1500 } = {}) {
    this.loadPty = loadPty;
    this.signalTree = signalProcessTree;
    this.maxSessions = safeInteger(maxSessions, MAX_ACTIVE_SESSIONS, 1, MAX_ACTIVE_SESSIONS);
    this.bufferLimit = safeInteger(bufferLimit, DEFAULT_BUFFER_CHARS, 1024, 4 * 1024 * 1024);
    this.killGraceMs = safeInteger(killGraceMs, 1500, 10, 10000);
    this.idFactory = idFactory || (() => 'term_' + randomBytes(8).toString('hex'));
    this.sessions = new Map();
    this.startingSessions = 0;
    this.ptyPromise = null;
  }

  async _pty() {
    if (!this.ptyPromise) this.ptyPromise = Promise.resolve().then(this.loadPty).then((module) => {
      const pty = module && (typeof module.spawn === 'function' ? module : module.default);
      if (!pty || typeof pty.spawn !== 'function') throw new Error('The node-pty package did not expose its spawn API.');
      return pty;
    }).catch((error) => {
      this.ptyPromise = null;
      const missing = error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND');
      if (missing) {
        throw new Error('Interactive terminals need the optional native node-pty component, which is not available in this installation. Standard command execution still works. Install the OASIS native terminal prerequisites for your operating system, then run npm rebuild node-pty. See docs/INSTALL.md. Original error: ' + String(error.message || error));
      }
      throw new Error('OASIS could not load its native terminal component: ' + String(error && error.message || error));
    });
    return await this.ptyPromise;
  }

  _get(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new Error('No terminal session exists with that id in this OASIS session.');
    return record;
  }

  _prune() {
    const exited = [...this.sessions.values()].filter((record) => record.state === 'exited' || record.state === 'error');
    while (this.sessions.size >= MAX_RETAINED_SESSIONS && exited.length) {
      const record = exited.shift();
      this.sessions.delete(record.id);
    }
  }

  _terminateRecord(record, { force = false } = {}) {
    if (force || process.platform === 'win32') {
      if (record.stopTimer) clearTimeout(record.stopTimer);
      record.stopTimer = null;
      this.signalTree(record.process, 'SIGKILL');
      return;
    }
    this.signalTree(record.process, 'SIGTERM');
    if (record.stopTimer) return;
    // Do not clear this timer when the PTY leader exits: descendants may have
    // ignored SIGTERM and may not share the PTY's observable exit lifecycle.
    record.stopTimer = setTimeout(() => {
      record.stopTimer = null;
      this.signalTree(record.process, 'SIGKILL');
    }, this.killGraceMs);
    record.stopTimer.unref?.();
  }

  async start(command, args = [], options = {}) {
    const nul = String.fromCharCode(0);
    if (typeof command !== 'string' || !command.trim() || command.length > 1000 || command.includes(nul)) {
      throw new Error('A terminal session needs one valid executable name or path.');
    }
    if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes(nul))) {
      throw new Error('Terminal arguments must be an array of short strings.');
    }
    if (!options.cwd || typeof options.cwd !== 'string') throw new Error('A workspace path is required to start a terminal session.');
    const active = [...this.sessions.values()].filter((record) => record.state === 'running' || record.state === 'stopping').length;
    if (active + this.startingSessions >= this.maxSessions) throw new Error('OASIS already has ' + (active + this.startingSessions) + ' active or starting terminal sessions. Stop an unused session before opening another.');
    this.startingSessions += 1;
    try {
      this._prune();
      const pty = await this._pty();
      const cols = safeInteger(options.cols, 100, 20, 300);
      const rows = safeInteger(options.rows, 30, 5, 120);
      const display = String(options.display || command.split(/[\\/]/).pop() || command).slice(0, 180);
      const child = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd,
        env: options.env || process.env,
        encoding: 'utf8',
        handleFlowControl: true
      });
      const record = {
        id: String(this.idFactory()),
        display,
        cwd: options.cwd,
        process: child,
        state: 'running',
        cols,
        rows,
        output: '',
        outputBase: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        stopTimer: null,
        sandboxed: options.sandboxed || null,
        waiters: new Set(),
        dataDisposable: null,
        exitDisposable: null
      };
      if (!record.id || this.sessions.has(record.id)) {
        try { child.kill(); } catch {}
        throw new Error('Could not allocate a unique terminal session id.');
      }
      this.sessions.set(record.id, record);
      const notify = () => {
        for (const waiter of [...record.waiters]) {
          try { waiter(); } catch {}
        }
      };
      record.dataDisposable = child.onData((chunk) => {
        if (record.state !== 'running' && record.state !== 'stopping') return;
        const text = String(chunk || '');
        record.output += text;
        if (record.output.length > this.bufferLimit) {
          const excess = record.output.length - this.bufferLimit;
          record.output = record.output.slice(excess);
          record.outputBase += excess;
        }
        record.updatedAt = new Date().toISOString();
        notify();
      });
      record.exitDisposable = child.onExit((event = {}) => {
        record.state = 'exited';
        record.exitCode = Number.isFinite(event.exitCode) ? event.exitCode : 0;
        record.signal = Number.isFinite(event.signal) && event.signal !== 0 ? event.signal : null;
        record.updatedAt = new Date().toISOString();
        notify();
        try { record.dataDisposable && record.dataDisposable.dispose(); } catch {}
      });
        return { ...statusOf(record), message: 'Interactive terminal started. Use terminal_read with this id to receive output; use terminal_input to send keystrokes or program input, terminal_resize to resize, and terminal_stop when finished.' };
    } finally {
      this.startingSessions = Math.max(0, this.startingSessions - 1);
    }
  }

  list() {
    return { sessions: [...this.sessions.values()].map(statusOf) };
  }

  async read(id, { offset = 0, maxChars = 12000, waitMs = 0 } = {}) {
    const record = this._get(id);
    const requested = safeInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = safeInteger(maxChars, 12000, 1, MAX_READ_CHARS);
    const wait = safeInteger(waitMs, 0, 0, 30000);
    const hasOutput = () => record.outputBase + record.output.length > requested || record.state !== 'running';
    if (wait > 0 && !hasOutput()) {
      await new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          record.waiters.delete(finish);
          resolve();
        };
        timer = setTimeout(finish, wait);
        timer.unref?.();
        record.waiters.add(finish);
        if (hasOutput()) finish();
      });
    }
    const endOffset = record.outputBase + record.output.length;
    const truncated = requested < record.outputBase;
    const actualOffset = Math.max(requested, record.outputBase);
    const startIndex = Math.max(0, actualOffset - record.outputBase);
    const output = record.output.slice(startIndex, startIndex + limit);
    return {
      ...statusOf(record),
      output,
      offset: actualOffset,
      nextOffset: actualOffset + output.length,
      truncated,
      waiting: Boolean(wait > 0 && output.length === 0 && record.state === 'running'),
      ...(actualOffset + output.length < endOffset ? { moreOutput: true } : {})
    };
  }

  write(id, data) {
    const record = this._get(id);
    const text = String(data ?? '');
    if (text.length > MAX_INPUT_CHARS) throw new Error('Terminal input is too large. Send at most ' + MAX_INPUT_CHARS + ' characters per call.');
    if (record.state !== 'running') throw new Error('Terminal input is only accepted while the session is running.');
    record.process.write(text);
    record.updatedAt = new Date().toISOString();
    return { id: record.id, writtenChars: text.length, state: record.state };
  }

  resize(id, cols, rows) {
    const record = this._get(id);
    const width = safeInteger(cols, 100, 20, 300);
    const height = safeInteger(rows, 30, 5, 120);
    if (record.state !== 'running') throw new Error('Only a running terminal session can be resized.');
    record.process.resize(width, height);
    record.cols = width;
    record.rows = height;
    record.updatedAt = new Date().toISOString();
    return statusOf(record);
  }

  interrupt(id) {
    const record = this._get(id);
    if (record.state !== 'running') return { id: record.id, state: record.state, interrupted: false };
    record.process.write(String.fromCharCode(3));
    record.updatedAt = new Date().toISOString();
    return { id: record.id, state: record.state, interrupted: true, message: 'Sent Ctrl+C to the running terminal. The program may handle or ignore the interrupt; use terminal_stop if it must be terminated.' };
  }

  stop(id) {
    const record = this._get(id);
    if (record.state !== 'running' && record.state !== 'stopping') return { ...statusOf(record), stopped: false };
    record.state = 'stopping';
    record.updatedAt = new Date().toISOString();
    try { this._terminateRecord(record); }
    catch (error) { throw new Error('Could not stop terminal process tree ' + record.id + ': ' + String(error.message || error)); }
    return { ...statusOf(record), stopped: true };
  }

  async waitForExit(id, timeoutMs = 10000) {
    const record = this._get(id);
    if (record.state === 'exited' || record.state === 'error') return statusOf(record);
    const timeout = safeInteger(timeoutMs, 10000, 1, 60000);
    return await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(onChange);
        resolve({ ...statusOf(record), ...(timedOut ? { timedOut: true } : {}) });
      };
      const onChange = () => {
        if (record.state === 'exited' || record.state === 'error') finish(false);
      };
      timer = setTimeout(() => finish(true), timeout);
      timer.unref?.();
      record.waiters.add(onChange);
      onChange();
    });
  }

  closeAll() {
    let stopped = 0;
    for (const record of this.sessions.values()) {
      if (record.state !== 'running' && record.state !== 'stopping') continue;
      record.state = 'stopping';
      try { this._terminateRecord(record, { force: true }); stopped += 1; } catch {}
    }
    this.sessions.clear();
    return { stopped };
  }
}
