// Interactive terminal for the browser workspace. It starts the server's shell through
// /api/terminal/command (interactive: true), so the same approval prompt as any command
// applies, then streams the PTY with long-polled reads and forwards keystrokes and resizes.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let vendorPromise = null;
// xterm.js is vendored under /assets/vendor and loaded only when a terminal is first opened.
export function loadXterm(doc = document) {
  if (globalThis.Terminal && globalThis.FitAddon) return Promise.resolve();
  if (vendorPromise) return vendorPromise;
  const script = (src) => new Promise((resolve, reject) => {
    const el = doc.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load ' + src));
    doc.head.appendChild(el);
  });
  if (!doc.querySelector('link[data-xterm]')) {
    const link = Object.assign(doc.createElement('link'), { rel: 'stylesheet', href: '/assets/vendor/xterm.css' });
    link.dataset.xterm = '1';
    doc.head.appendChild(link);
  }
  vendorPromise = script('/assets/vendor/xterm.js').then(() => script('/assets/vendor/xterm-addon-fit.js')).then(() => {
    if (typeof globalThis.Terminal !== 'function') throw new Error('The terminal renderer is not installed.');
  }).catch((error) => { vendorPromise = null; throw error; });
  return vendorPromise;
}

// xterm wraps at the last column, mid-word. Notes are split at spaces so each
// row fits `cols - 1` columns; a word longer than that keeps its own row.
export function wrapWords(text, cols) {
  const width = Math.max(20, (Number(cols) || 80) - 1);
  const rows = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line && line.length + 1 + word.length > width) { rows.push(line); line = word; } else line = line ? line + ' ' + word : word;
  }
  if (line) rows.push(line);
  return rows;
}

export class RuntimeTerminal {
  constructor({ client, approve = async () => false, onStatus = () => {}, onOutput = () => {}, onExit = () => {}, pollMs = 400 } = {}) {
    this.client = client;
    this.approve = approve;
    this.onStatus = onStatus;
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.pollMs = pollMs;
    this.id = '';
    this.offset = 0;
    this.generation = 0;
  }

  get running() { return Boolean(this.id); }

  async start(command, args = []) {
    if (this.id) return this.id;
    const generation = ++this.generation;
    this.onStatus('Waiting for approval…');
    const started = await this.client.api('/api/terminal/command', { method: 'POST', body: { command, args, interactive: true, companion: true, timeoutSeconds: 600, ...(this.size || {}) } });
    let after = 0;
    for (;;) {
      if (generation !== this.generation) return '';
      const job = await this.client.api('/api/jobs/' + started.jobId + '?after=' + after);
      for (const event of job.events || []) {
        after = Math.max(after, event.id);
        const data = event.data || {};
        if (event.type === 'approval_required') {
          const value = await this.approve({ name: 'run_command', args: { prompt: data.prompt, suggestion: data.suggestion, risky: data.risky }, runtime: true });
          await this.client.api('/api/jobs/' + started.jobId + '/approval', { method: 'POST', body: { approvalId: data.approvalId, approved: value === 'always' || value === true, always: value === 'always' } }).catch(() => {});
        } else if (event.type === 'terminal_pty_started' && data.id) {
          this.id = data.id;
          this.offset = 0;
          this.onStatus('Running');
          void this.poll(data.id);
          return data.id;
        } else if (event.type === 'terminal_output') {
          const reason = data.approved === false ? 'Not started: you declined it.' : (String(data.output || '').trim() || 'The terminal exited.');
          this.onStatus(reason);
          return '';
        } else if (event.type === 'failed') {
          this.onStatus('Could not start: ' + (data.message || 'unknown error'));
          return '';
        }
      }
      if (['completed', 'error', 'cancelled'].includes(job.status)) { this.onStatus(job.status === 'cancelled' ? 'Cancelled.' : 'The terminal did not start.'); return ''; }
      await pause(this.pollMs);
    }
  }

  async poll(id) {
    while (this.id === id) {
      let data;
      try {
        data = await this.client.api('/api/terminal/pty/read?id=' + encodeURIComponent(id) + '&offset=' + this.offset + '&max_chars=32000&wait_seconds=10');
      } catch (error) {
        if (this.id !== id) return;
        this.id = '';
        this.onStatus('Connection lost: ' + (error.message || String(error)) + '. Reopen the tab to reconnect.');
        this.onExit(null, { lost: true });
        return;
      }
      if (this.id !== id) return;
      if (data.output) this.onOutput(data.output, { truncated: Boolean(data.truncated) });
      this.offset = data.nextOffset;
      if (data.state !== 'running' && data.state !== 'stopping') {
        this.id = '';
        this.onStatus('Exited' + (data.exitCode === undefined || data.exitCode === null ? '' : ' with code ' + data.exitCode));
        this.onExit(data.exitCode);
        return;
      }
      if (!data.output && !data.moreOutput) await pause(80);
    }
  }

  // Reconnect to a shell that is still running on the server (after a page reload).
  async attach(id) {
    if (this.id || !id) return false;
    const listed = await this.client.api('/api/terminal/pty/list').catch(() => null);
    const sessions = Array.isArray(listed) ? listed : (listed && Array.isArray(listed.sessions) ? listed.sessions : []);
    const found = sessions.find((session) => session.id === id && (session.state === 'running' || session.state === 'stopping'));
    if (!found) return false;
    this.generation++;
    this.id = id;
    this.offset = 0;
    this.onStatus('Running');
    void this.poll(id);
    return true;
  }

  write(data) {
    if (!this.id || !data) return Promise.resolve();
    return this.client.api('/api/terminal/pty/input', { method: 'POST', body: { id: this.id, data } }).catch((error) => this.onStatus(error.message || String(error)));
  }

  resize(cols, rows) {
    if (!this.id || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return Promise.resolve();
    return this.client.api('/api/terminal/pty/resize', { method: 'POST', body: { id: this.id, cols, rows } }).catch(() => {});
  }

  async stop() {
    this.generation++;
    const id = this.id;
    if (!id) return;
    await this.client.api('/api/terminal/pty/stop', { method: 'POST', body: { id } }).catch(() => {});
  }
}
