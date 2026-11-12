// fetch() for model servers on this machine (llama.cpp, Ollama, LM Studio, vLLM).
//
// Node's built-in fetch (undici) aborts when response headers take longer than
// 300 seconds (headersTimeout) or the body goes quiet for 300 seconds
// (bodyTimeout). llama-server sends no headers until it has read the whole
// prompt, which on a laptop CPU can take longer than that, so every long request
// failed at the five-minute mark regardless of OASIS_REQUEST_TIMEOUT_SECONDS.
// This uses node:http with no hidden timeouts; the caller's AbortSignal and
// OASIS's own first-byte and stream-idle timers stay in charge.
import http from 'node:http';
import https from 'node:https';

const NATIVE_FETCH = globalThis.fetch;
/** Marks fetch replacements installed by OASIS itself (the proxy), as opposed to test stubs. */
export const OASIS_FETCH = Symbol.for('oasis.fetch');

/** The fetch to use for a model request: loopbackFetch for local servers, unless fetch was replaced (tests). */
export function providerFetch(local) {
  const own = globalThis.fetch === NATIVE_FETCH || Boolean(globalThis.fetch && globalThis.fetch[OASIS_FETCH]);
  return local && own && process.env.OASIS_LOOPBACK_FETCH !== '0' ? loopbackFetch : globalThis.fetch;
}

export function loopbackFetch(input, init = {}) {
  let url;
  try { url = new URL(String(input)); } catch { return Promise.reject(new TypeError('Invalid URL: ' + input)); }
  return nodeFetch(url, init, (target, options, onResponse) => (target.protocol === 'https:' ? https : http).request(target, options, onResponse));
}

/**
 * fetch() semantics over node:http. openRequest(url, options, onResponse) returns a
 * ClientRequest (or a promise of one), so callers choose how to connect (direct, proxy).
 */
function nodeFetch(url, init = {}, openRequest) {
  return new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal && signal.aborted) { reject(abortError(signal)); return; }
    const headers = {};
    const source = init.headers || {};
    if (typeof source.forEach === 'function' && !Array.isArray(source)) source.forEach((value, key) => { headers[key] = value; });
    else for (const [key, value] of Object.entries(source)) headers[key] = value;
    const body = init.body == null ? null : Buffer.from(typeof init.body === 'string' ? init.body : init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body);
    if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) headers['content-length'] = String(body.length);
    const onResponse = (response) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
        else if (value != null) responseHeaders.set(key, String(value));
      }
      const status = response.statusCode || 502;
      const nullBody = status === 204 || status === 304 || (init.method || 'GET').toUpperCase() === 'HEAD';
      if (nullBody) response.resume();
      resolve(new Response(nullBody ? null : bodyStream(response, signal), { status, statusText: response.statusMessage || '', headers: responseHeaders }));
    };
    // Match fetch: network failures are TypeErrors (callers retry those), aborts are AbortErrors.
    const fail = (error) => reject(error && error.name === 'AbortError' ? error : Object.assign(new TypeError('fetch failed'), { cause: error }));
    Promise.resolve().then(() => openRequest(url, { method: init.method || 'GET', headers, timeout: 0 }, onResponse)).then((request) => {
      const onAbort = () => request.destroy(abortError(signal));
      if (signal) {
        if (signal.aborted) { onAbort(); }
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      request.on('error', (error) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        fail(error);
      });
      request.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
      if (body) request.end(body); else request.end();
    }, fail);
  });
}

// Like undici: a connection that drops mid-body errors the stream with
// TypeError('terminated'), which the agent treats as a restartable interruption.
function bodyStream(response, signal) {
  const chunks = response[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (error) {
        controller.error(signal && signal.aborted ? abortError(signal) : Object.assign(new TypeError('terminated'), { cause: error }));
      }
    },
    cancel() { response.destroy(); },
  });
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}
