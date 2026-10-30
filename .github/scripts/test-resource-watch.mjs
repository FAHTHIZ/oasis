// Temporary CI diagnostic: report Node processes that remain alive after tests finish.
const watchdog = setTimeout(() => {
  const handles = typeof process._getActiveHandles === 'function'
    ? process._getActiveHandles().map((handle) => {
        const item = { type: handle && handle.constructor ? handle.constructor.name : typeof handle };
        for (const key of ['pid', 'exitCode', 'signalCode', 'killed', 'fd', 'destroyed', 'readableEnded', 'writableEnded', 'connecting']) {
          if (handle && handle[key] !== undefined) item[key] = handle[key];
        }
        if (handle && typeof handle.address === 'function') {
          try { item.address = handle.address(); } catch {}
        }
        return item;
      })
    : [];
  const resources = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  console.error('[OASIS test-resource-watch] ' + JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
    resources,
    handles
  }));
}, 75000);
watchdog.unref();
