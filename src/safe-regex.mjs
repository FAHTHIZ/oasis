import { Worker } from 'node:worker_threads';

const DEFAULT_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 5000;
const MAX_PENDING_MATCHES = 64;

export function createBoundedRegexMatcher(pattern, flags = '', options = {}) {
  const requested = Number(options.timeoutMs);
  const timeoutMs = Number.isInteger(requested) && requested >= 10 && requested <= MAX_TIMEOUT_MS
    ? requested : DEFAULT_TIMEOUT_MS;
  const worker = new Worker(new URL('./regex-worker.mjs', import.meta.url), {
    workerData: { pattern: String(pattern), flags: String(flags) }
  });

  let state = 'starting';
  let failure = null;
  let nextId = 0;
  let termination = null;
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});

  const cleanupEntry = (entry) => {
    clearTimeout(entry.timer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
  };
  const rejectPending = (error) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      cleanupEntry(entry);
      entry.reject(error);
    }
  };
  const terminate = (reason) => {
    if (state === 'closed') return termination || Promise.resolve();
    const wasStarting = state === 'starting';
    state = 'closed';
    failure = reason instanceof Error ? reason : new Error(String(reason));
    if (wasStarting) rejectReady(failure);
    rejectPending(failure);
    termination = worker.terminate().catch(() => {});
    return termination;
  };

  worker.on('message', (message) => {
    if (message && message.type === 'ready') {
      if (state === 'starting') {
        state = 'ready';
        resolveReady();
      }
      return;
    }
    if (message && message.type === 'init-error') {
      void terminate(new Error('Invalid regular expression: ' + String(message.error || 'could not compile')));
      return;
    }
    const entry = message && pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    cleanupEntry(entry);
    if (message.error) entry.reject(new Error(String(message.error)));
    else entry.resolve(Boolean(message.matched));
  });
  worker.on('error', (error) => { void terminate(error); });
  worker.on('exit', (code) => {
    if (state !== 'closed') void terminate(new Error('Regex worker exited unexpectedly with code ' + code + '.'));
  });

  return {
    ready,
    async test(value, { signal } = {}) {
      await ready;
      if (state !== 'ready') throw failure || new Error('Regex worker is unavailable.');
      if (signal && signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Regex matching cancelled.');
      }
      if (pending.size >= MAX_PENDING_MATCHES) throw new Error('Too many regex matches are queued.');
      const id = ++nextId;
      return await new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null, signal, abort: null };
        entry.timer = setTimeout(() => {
          void terminate(new Error('Regular expression matching exceeded the ' + timeoutMs + ' ms time limit; the worker was terminated.'));
        }, timeoutMs);
        if (signal) {
          entry.abort = () => {
            void terminate(signal.reason instanceof Error ? signal.reason : new Error('Regex matching cancelled.'));
          };
          signal.addEventListener('abort', entry.abort, { once: true });
        }
        pending.set(id, entry);
        try {
          worker.postMessage({ id, value: String(value) });
        } catch (error) {
          void terminate(error);
        }
      });
    },
    async close() {
      if (state !== 'closed') await terminate(new Error('Regex worker closed.'));
      else if (termination) await termination;
    }
  };
}
