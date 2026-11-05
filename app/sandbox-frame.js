// Runs inside a sandboxed iframe (opaque origin, no network). Each job gets a
// fresh worker so a runaway loop is ended by terminating it.
(function () {
  var runtimeUrl = null;
  function reply(id, result) { parent.postMessage({ type: 'result', id: id, result: result }, '*'); }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var job = event.data;
    if (!job || job.type !== 'run') return;
    if (!runtimeUrl) runtimeUrl = URL.createObjectURL(new Blob([job.runtime + '\nself.onmessage = async function (e) { self.postMessage(await self.__oasisRun(e.data.code, e.data.files)); };'], { type: 'text/javascript' }));
    var worker;
    try { worker = new Worker(runtimeUrl); } catch (e) { worker = null; }
    if (!worker) {
      try {
        if (!self.__oasisRun) (0, eval)(job.runtime);
        self.__oasisRun(job.code, job.files).then(function (r) { reply(job.id, r); }, function (e) { reply(job.id, { logs: [], error: String(e) }); });
      } catch (e) { reply(job.id, { logs: [], error: String(e) }); }
      return;
    }
    var timer = setTimeout(function () { worker.terminate(); reply(job.id, { logs: [], timedOut: true, error: 'Timed out' }); }, job.timeoutMs);
    worker.onmessage = function (e) { clearTimeout(timer); worker.terminate(); reply(job.id, e.data); };
    worker.onerror = function (e) { clearTimeout(timer); worker.terminate(); reply(job.id, { logs: [], error: String(e.message || e) }); };
    worker.postMessage({ code: job.code, files: job.files });
  });
  parent.postMessage({ type: 'ready' }, '*');
})();
