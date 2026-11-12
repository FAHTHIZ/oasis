// Isolated JavaScript runner for the universal app.
// In the browser, code runs in a Worker started inside a sandboxed iframe
// (sandbox.html: opaque origin, so no access to the app, its storage or keys)
// whose content security policy blocks every network request. A timeout terminates the
// worker, so infinite loops cannot freeze the app. The runtime itself is plain
// JavaScript so tests can run it in Node.

/** Source of the in-sandbox runtime. Defines self.__oasisRun(code, files). */
function runtimeSource() {
  return String.raw`
(function () {
  function format(value, depth) {
    depth = depth || 0;
    if (typeof value === 'string') return depth ? JSON.stringify(value) : value;
    if (value === undefined) return 'undefined';
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (typeof value === 'symbol') return value.toString();
    if (value instanceof Error) return (value.stack && depth === 0 ? value.stack : value.name + ': ' + value.message);
    if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]';
    if (Array.isArray(value)) return '[ ' + value.slice(0, 100).map(function (v) { return format(v, depth + 1); }).join(', ') + (value.length > 100 ? ', … ' + (value.length - 100) + ' more' : '') + ' ]';
    if (value instanceof Map) return 'Map(' + value.size + ') { ' + Array.from(value).slice(0, 50).map(function (e) { return format(e[0], depth + 1) + ' => ' + format(e[1], depth + 1); }).join(', ') + ' }';
    if (value instanceof Set) return 'Set(' + value.size + ') { ' + Array.from(value).slice(0, 50).map(function (v) { return format(v, depth + 1); }).join(', ') + ' }';
    try {
      var keys = Object.keys(value);
      return '{ ' + keys.slice(0, 50).map(function (k) { return k + ': ' + format(value[k], depth + 1); }).join(', ') + (keys.length > 50 ? ', …' : '') + ' }';
    } catch (e) { return String(value); }
  }

  function deepEqual(a, b, strict) {
    if (strict ? Object.is(a, b) : a == b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (var entry of a) if (!b.has(entry[0]) || !deepEqual(entry[1], b.get(entry[0]), strict)) return false;
      return true;
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false;
      for (var item of a) if (!b.has(item)) return false;
      return true;
    }
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !deepEqual(a[ka[i]], b[ka[i]], strict)) return false;
    return true;
  }

  function AssertionError(message) { var e = new Error(message); e.name = 'AssertionError'; return e; }
  function fail(message, fallback) { throw AssertionError(message || fallback); }
  var assert = function (value, message) { if (!value) fail(message, 'Expected a truthy value, got ' + format(value, 1)); };
  assert.ok = assert;
  assert.equal = function (a, b, m) { if (a != b) fail(m, format(a, 1) + ' == ' + format(b, 1)); };
  assert.notEqual = function (a, b, m) { if (a == b) fail(m, format(a, 1) + ' != ' + format(b, 1)); };
  assert.strictEqual = function (a, b, m) { if (!Object.is(a, b)) fail(m, 'Expected ' + format(b, 1) + ', got ' + format(a, 1)); };
  assert.notStrictEqual = function (a, b, m) { if (Object.is(a, b)) fail(m, 'Expected values to differ: ' + format(a, 1)); };
  assert.deepEqual = function (a, b, m) { if (!deepEqual(a, b, false)) fail(m, 'Expected ' + format(b, 1) + ', got ' + format(a, 1)); };
  assert.deepStrictEqual = function (a, b, m) { if (!deepEqual(a, b, true)) fail(m, 'Expected ' + format(b, 1) + ', got ' + format(a, 1)); };
  assert.notDeepStrictEqual = function (a, b, m) { if (deepEqual(a, b, true)) fail(m, 'Expected values to differ deeply'); };
  assert.match = function (s, re, m) { if (!re.test(s)) fail(m, format(s, 1) + ' does not match ' + re); };
  assert.fail = function (m) { fail(m, 'Failed'); };
  function checkError(error, expected) {
    if (!expected) return;
    if (expected instanceof RegExp) { if (!expected.test(String(error && error.message || error))) fail(null, 'Error ' + format(error, 1) + ' does not match ' + expected); }
    else if (typeof expected === 'function') { if (!(error instanceof expected) && expected(error) !== true) fail(null, 'Unexpected error: ' + format(error, 1)); }
    else if (typeof expected === 'object') for (var key in expected) if (!deepEqual(error[key], expected[key], true)) fail(null, 'Error.' + key + ' was ' + format(error[key], 1));
  }
  assert.throws = function (fn, expected, m) { try { fn(); } catch (e) { checkError(e, expected); return; } fail(typeof expected === 'string' ? expected : m, 'Expected the function to throw'); };
  assert.doesNotThrow = function (fn, m) { try { fn(); } catch (e) { fail(m, 'Unexpected throw: ' + format(e, 1)); } };
  assert.rejects = async function (p, expected, m) { try { await (typeof p === 'function' ? p() : p); } catch (e) { checkError(e, expected); return; } fail(m, 'Expected a rejection'); };
  assert.strict = assert;

  self.__oasisRun = async function (code, files) {
    var logs = [];
    var size = 0;
    function log(prefix) {
      return function () {
        var line = prefix + Array.prototype.map.call(arguments, function (v) { return format(v, 0); }).join(' ');
        size += line.length;
        if (size < 200000) logs.push(line);
      };
    }
    var sandboxConsole = { log: log(''), info: log(''), debug: log(''), warn: log('warn: '), error: log('error: '), table: log('') };
    var tests = [];
    function test(name, fn) { if (typeof name === 'function') { fn = name; name = fn.name || 'test'; } tests.push({ name: String(name), fn: fn }); }
    test.skip = function () {};
    var describeStack = [];
    function describe(name, fn) { describeStack.push(name); try { fn(); } finally { describeStack.pop(); } }
    function it(name, fn) { test(describeStack.concat(name).join(' > '), fn); }
    var builtins = { assert: assert, 'assert/strict': assert, 'node:assert': assert, 'node:assert/strict': assert, 'node:test': { test: test, describe: describe, it: it, default: test } };

    function dirname(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
    function join(base, rel) {
      var parts = (base ? base.split('/') : []);
      rel.split('/').forEach(function (part) {
        if (!part || part === '.') return;
        if (part === '..') parts.pop(); else parts.push(part);
      });
      return parts.join('/');
    }
    function resolve(from, request) {
      var base = request.charAt(0) === '/' ? '' : from;
      var target = join(base, request.replace(/^\/+/, ''));
      var candidates = [target, target + '.js', target + '.cjs', target + '.json', target + '/index.js'];
      for (var i = 0; i < candidates.length; i++) if (Object.prototype.hasOwnProperty.call(files, candidates[i])) return candidates[i];
      return null;
    }
    var cache = {};
    function makeRequire(fromDir) {
      return function require(request) {
        if (Object.prototype.hasOwnProperty.call(builtins, request)) return builtins[request];
        if (!/^(\.{1,2}\/|\/)/.test(request)) throw new Error('Cannot load package "' + request + '" in the app sandbox. Only project files and assert are available.');
        var path = resolve(fromDir, request);
        if (!path) throw new Error('Cannot find module ' + request + ' from ' + (fromDir || '.'));
        if (cache[path]) return cache[path].exports;
        var module = { exports: {} };
        cache[path] = module;
        if (/\.json$/.test(path)) { module.exports = JSON.parse(files[path]); return module.exports; }
        var source = files[path];
        if (/^\s*(import|export)\s/m.test(source) && !/module\.exports|exports\./.test(source)) source = esmToCjs(source);
        var wrapper = new Function('module', 'exports', 'require', '__filename', '__dirname', 'console', 'test', 'describe', 'it', source + '\n//# sourceURL=' + path);
        wrapper(module, module.exports, makeRequire(dirname(path)), path, dirname(path), sandboxConsole, test, describe, it);
        return module.exports;
      };
    }
    // Small ES module support: import/export statements in project files.
    function esmToCjs(source) {
      var names = [];
      var out = source
        .replace(/^\s*import\s+([\w$]+)\s*,?\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm, function (_, d, list, from) { return 'const ' + d + ' = require(' + JSON.stringify(from) + ').default ?? require(' + JSON.stringify(from) + '); const {' + list.replace(/\s+as\s+/g, ': ') + '} = require(' + JSON.stringify(from) + ');'; })
        .replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm, function (_, list, from) { return 'const {' + list.replace(/\s+as\s+/g, ': ') + '} = require(' + JSON.stringify(from) + ');'; })
        .replace(/^\s*import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"];?/gm, function (_, n, from) { return 'const ' + n + ' = require(' + JSON.stringify(from) + ');'; })
        .replace(/^\s*import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"];?/gm, function (_, n, from) { return 'const ' + n + ' = (function (m) { return m && m.default !== undefined ? m.default : m; })(require(' + JSON.stringify(from) + '));'; })
        .replace(/^\s*import\s*['"]([^'"]+)['"];?/gm, function (_, from) { return 'require(' + JSON.stringify(from) + ');'; })
        .replace(/^\s*export\s+default\s+/gm, 'module.exports.default = ')
        .replace(/^\s*export\s+(async\s+function\*?|function\*?|class|const|let|var)\s+([\w$]+)/gm, function (_, kind, name) { names.push(name); return kind + ' ' + name; })
        .replace(/^\s*export\s*\{([^}]*)\};?/gm, function (_, list) { list.split(',').forEach(function (item) { var p = item.trim().split(/\s+as\s+/); if (p[0]) names.push(p[1] ? p[0] + ':' + p[1] : p[0]); }); return ''; });
      return out + '\n' + names.map(function (n) { var p = n.split(':'); return 'module.exports[' + JSON.stringify(p[1] || p[0]) + '] = ' + p[0] + ';'; }).join('\n');
    }

    var result = { logs: logs };
    try {
      var readFile = function (p) { var k = join('', String(p).replace(/^\.?\/+/, '')); if (!Object.prototype.hasOwnProperty.call(files, k)) throw new Error('No such file: ' + p); return files[k]; };
      var listFiles = function () { return Object.keys(files).sort(); };
      var body = /^\s*(import|export)\s/m.test(code) ? esmToCjs(code) : code;
      var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      var fn = new AsyncFunction('require', 'module', 'exports', 'console', 'assert', 'test', 'describe', 'it', 'readFile', 'listFiles', body + '\n//# sourceURL=oasis-run.js');
      var mod = { exports: {} };
      var value = await fn(makeRequire(''), mod, mod.exports, sandboxConsole, assert, test, describe, it, readFile, listFiles);
      if (tests.length) {
        var passed = 0, failed = 0;
        for (var t = 0; t < tests.length; t++) {
          try { await tests[t].fn(); passed++; logs.push('ok ' + (t + 1) + ' - ' + tests[t].name); }
          catch (e) { failed++; logs.push('not ok ' + (t + 1) + ' - ' + tests[t].name + '\n    ' + format(e, 1)); }
        }
        logs.push('# tests ' + tests.length + ', pass ' + passed + ', fail ' + failed);
        if (failed) result.error = failed + ' test' + (failed === 1 ? '' : 's') + ' failed';
      }
      if (value !== undefined) result.value = format(value, 1);
    } catch (e) {
      result.error = format(e, 0);
    }
    return result;
  };
})();
`;
}

/** Browser sandbox: a hidden sandboxed iframe that runs jobs in workers. */
export class FrameSandbox {
  constructor(doc = globalThis.document, src = 'sandbox.html') {
    this.doc = doc;
    this.src = src;
    this.runtime = runtimeSource();
    this.frame = null;
    this.ready = null;
    this.jobs = new Map();
    this.seq = 0;
    this.onMessage = (event) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return;
      const data = event.data || {};
      if (data.type === 'ready' && this.resolveReady) this.resolveReady();
      if (data.type === 'result' && this.jobs.has(data.id)) {
        const job = this.jobs.get(data.id);
        this.jobs.delete(data.id);
        clearTimeout(job.guard);
        job.resolve(data.result || { logs: [] });
      }
    };
    globalThis.addEventListener('message', this.onMessage);
  }

  start() {
    if (this.ready) return this.ready;
    this.frame = this.doc.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.frame.src = this.src;
    this.doc.body.appendChild(this.frame);
    return this.ready;
  }

  reset() {
    if (this.frame) this.frame.remove();
    this.frame = null;
    this.ready = null;
    for (const job of this.jobs.values()) job.resolve({ logs: [], error: 'Sandbox restarted' });
    this.jobs.clear();
  }

  async run(code, { files = {}, timeoutMs = 10000 } = {}) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      // A second, outer guard: if the frame itself hangs (no worker support),
      // drop it entirely and start fresh next time.
      const guard = setTimeout(() => {
        this.jobs.delete(id);
        this.reset();
        resolve({ logs: [], timedOut: true, error: 'Timed out' });
      }, timeoutMs + 2000);
      this.jobs.set(id, { resolve, guard });
      this.frame.contentWindow.postMessage({ type: 'run', id, code, files, timeoutMs, runtime: this.runtime }, '*');
    });
  }
}

/** In-process sandbox for tests and for hosts without iframes. Not isolated. */
export class InlineSandbox {
  constructor() {
    const scope = {};
    new Function('self', runtimeSource())(scope);
    this.runner = scope.__oasisRun;
  }
  async run(code, { files = {}, timeoutMs = 10000 } = {}) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ logs: [], timedOut: true, error: 'Timed out' }), timeoutMs); });
    try { return await Promise.race([this.runner(code, files), timeout]); }
    finally { clearTimeout(timer); }
  }
}
