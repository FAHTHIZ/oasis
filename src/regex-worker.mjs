import { parentPort, workerData } from 'node:worker_threads';

let expression = null;
try {
  expression = new RegExp(String(workerData.pattern), String(workerData.flags || ''));
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'init-error', error: error.message || String(error) });
}

parentPort.on('message', (message) => {
  if (!expression || !message || !Number.isSafeInteger(message.id)) return;
  try {
    expression.lastIndex = 0;
    parentPort.postMessage({ id: message.id, matched: expression.test(String(message.value)) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error.message || String(error) });
  }
});
