import { getQuickJS } from 'quickjs-emscripten';

const MAX_BRIDGE_JSON_CHARS = 256 * 1024;
const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_STACK_BYTES = 512 * 1024;
const MAX_SYNC_SLICE_MS = 2000;
const MAX_ITEMS_PER_CALL = 4096;

function errorText(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** Run workflow-authored JavaScript in a separate QuickJS WebAssembly runtime. */
export async function runWorkflowScript({ body, args, agent, phase, log, signal, onLimit = () => {} }) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  let context = null;
  let alive = false;
  let executionDeadline = 0;
  const runSlice = (fn) => {
    executionDeadline = Date.now() + MAX_SYNC_SLICE_MS;
    try { return fn(); } finally { executionDeadline = 0; }
  };
  runtime.setInterruptHandler(() => Boolean(signal && signal.aborted) || (executionDeadline > 0 && Date.now() >= executionDeadline));
  context = runtime.newContext();
  alive = true;

  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  void abortPromise.catch(() => {});
  const handleAbort = () => rejectAbort(signal && signal.reason instanceof Error ? signal.reason : new Error('Workflow cancelled.'));
  if (signal && signal.aborted) handleAbort();
  else if (signal) signal.addEventListener('abort', handleAbort, { once: true });

  const takeResult = (result) => {
    if (result.error) {
      let message = 'Workflow JavaScript failed.';
      try {
        const dumped = context.dump(result.error);
        message = typeof dumped === 'string' ? dumped : dumped && dumped.message ? dumped.message : JSON.stringify(dumped);
      } catch {}
      result.error.dispose();
      throw new Error(message);
    }
    return result.value;
  };
  const pumpJobs = () => {
    if (!alive || (signal && signal.aborted)) return;
    try {
      const result = runSlice(() => runtime.executePendingJobs());
      if (result.error) {
        let detail = 'QuickJS interrupted an overlong JavaScript execution slice.';
        try { detail = errorText(context.dump(result.error)); } catch {}
        result.error.dispose();
        onLimit(new Error('Workflow JavaScript execution interrupted: ' + detail));
      }
    } catch (error) {
      onLimit(error instanceof Error ? error : new Error(errorText(error)));
    }
  };
  const settlePromise = (deferred, value, rejected) => {
    if (!alive) return;
    let text;
    try {
      text = rejected ? errorText(value) : JSON.stringify(value === undefined ? null : value);
      if (text === undefined) text = 'null';
      if (text.length > MAX_BRIDGE_JSON_CHARS) {
        rejected = true;
        text = 'Workflow agent result exceeded the bridge size limit.';
      }
    } catch (error) {
      rejected = true;
      text = errorText(error);
    }
    let handle;
    try {
      handle = context.newString(text);
      if (rejected) deferred.reject(handle);
      else deferred.resolve(handle);
    } catch (error) {
      onLimit(error instanceof Error ? error : new Error(errorText(error)));
    } finally {
      if (handle) handle.dispose();
    }
    Promise.resolve(deferred.settled).then(pumpJobs).catch((error) => {
      if (alive) onLimit(error instanceof Error ? error : new Error(errorText(error)));
    });
  };

  try {
    const agentHandle = context.newFunction('__oasisAgent', (payloadHandle) => {
      const payload = context.getString(payloadHandle);
      if (payload.length > MAX_BRIDGE_JSON_CHARS) throw new Error('Workflow agent request exceeded the bridge size limit.');
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('Invalid workflow agent request.');
      const deferred = context.newPromise();
      Promise.resolve().then(() => agent(parsed[0], parsed[1])).then(
        (value) => settlePromise(deferred, value, false),
        (error) => settlePromise(deferred, error, true)
      );
      return deferred.handle;
    });
    agentHandle.consume((handle) => context.setProp(context.global, '__oasisAgent', handle));

    const phaseHandle = context.newFunction('__oasisPhase', (titleHandle) => {
      if (alive) phase(context.getString(titleHandle));
      return context.undefined;
    });
    phaseHandle.consume((handle) => context.setProp(context.global, '__oasisPhase', handle));

    const logHandle = context.newFunction('__oasisLog', (...parts) => {
      if (alive) {
        const safeParts = parts.map((part) => {
          try {
            const value = context.dump(part);
            if (typeof value === 'string') return value;
            const serialized = JSON.stringify(value);
            return serialized === undefined ? String(value) : serialized;
          } catch { return '[unserializable]'; }
        });
        log(...safeParts);
      }
      return context.undefined;
    });
    logHandle.consume((handle) => context.setProp(context.global, '__oasisLog', handle));

    const argsJson = JSON.stringify(args === undefined ? null : args);
    if (argsJson.length > MAX_BRIDGE_JSON_CHARS) throw new Error('Workflow args exceed the JSON bridge size limit.');
    const code = [
      '(async () => {',
      'const args = JSON.parse(' + JSON.stringify(argsJson) + ');',
      'const __workflowAgentBridge = globalThis.__oasisAgent;',
      'const __workflowPhaseBridge = globalThis.__oasisPhase;',
      'const __workflowLogBridge = globalThis.__oasisLog;',
      'delete globalThis.__oasisAgent; delete globalThis.__oasisPhase; delete globalThis.__oasisLog;',
      'const agent = (prompt, options = {}) => __workflowAgentBridge(JSON.stringify([prompt, options || {}])).then((json) => JSON.parse(json));',
      'const phase = (title) => __workflowPhaseBridge(String(title || ""));',
      'const log = (...parts) => __workflowLogBridge(...parts);',
      'const console = Object.freeze({ log, info: log, warn: log, error: log });',
      'const pipeline = (items, fn) => {',
      ' if (!Array.isArray(items)) throw new Error("pipeline() needs an array.");',
      ' if (items.length > ' + MAX_ITEMS_PER_CALL + ') throw new Error("pipeline() accepts at most ' + MAX_ITEMS_PER_CALL + ' items.");',
      ' if (typeof fn !== "function") throw new Error("pipeline() needs a function as its second argument.");',
      ' return Promise.all(items.map((item, index) => { try { return Promise.resolve(fn(item, index)).catch(() => null); } catch { return Promise.resolve(null); } }));',
      '};',
      'const parallel = (tasks) => {',
      ' if (!Array.isArray(tasks)) throw new Error("parallel() needs an array.");',
      ' if (tasks.length > ' + MAX_ITEMS_PER_CALL + ') throw new Error("parallel() accepts at most ' + MAX_ITEMS_PER_CALL + ' items.");',
      ' return Promise.all(tasks.map((task) => { try { return Promise.resolve(typeof task === "function" ? task() : task).catch(() => null); } catch { return Promise.resolve(null); } }));',
      '};',
      'const __workflowMath = Object.create(null);',
      'for (const key of Object.getOwnPropertyNames(globalThis.Math)) __workflowMath[key] = globalThis.Math[key];',
      'Object.defineProperty(__workflowMath, "random", { value: () => { throw new Error("Math.random() is unavailable in workflows; pass randomness through args."); } });',
      'Object.freeze(__workflowMath); const Math = __workflowMath;',
      'const __workflowNativeDate = globalThis.Date;',
      'class Date extends __workflowNativeDate { constructor(...values) { if (!values.length) throw new Error("new Date() without arguments is unavailable in workflows; pass a timestamp through args."); super(...values); } static now() { throw new Error("Date.now() is unavailable in workflows; pass a timestamp through args."); } }',
      'Date.parse = __workflowNativeDate.parse; Date.UTC = __workflowNativeDate.UTC; Object.freeze(Date);',
      body,
      '})()'
    ].join('\n');
    const evaluation = (async () => {
      const evalResult = runSlice(() => context.evalCode(code));
      const promiseHandle = takeResult(evalResult);
      try {
        const resolvedResult = await context.resolvePromise(promiseHandle);
        const valueHandle = takeResult(resolvedResult);
        try {
          const value = context.dump(valueHandle);
          const serialized = JSON.stringify(value);
          return serialized === undefined ? null : JSON.parse(serialized);
        } finally { valueHandle.dispose(); }
      } finally { promiseHandle.dispose(); }
    })();
    evaluation.catch(() => {});

    // QuickJS promises require the guest job queue to be pumped explicitly. Keep it moving
    // while host promises are pending too, and stop the pump on completion or cancellation.
    let evaluationSettled = false;
    const pumpTimer = setInterval(() => {
      if (!evaluationSettled && alive) pumpJobs();
    }, 1);
    evaluation.then(
      () => { evaluationSettled = true; clearInterval(pumpTimer); },
      () => { evaluationSettled = true; clearInterval(pumpTimer); }
    );
    pumpJobs();
    try {
      return await Promise.race([evaluation, abortPromise]);
    } finally {
      clearInterval(pumpTimer);
    }
  } finally {
    alive = false;
    if (signal) signal.removeEventListener('abort', handleAbort);
    try { context.dispose(); } catch {}
    try { runtime.dispose(); } catch {}
  }
}
