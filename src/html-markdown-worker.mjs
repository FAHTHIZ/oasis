// Worker thread for src/html-markdown.mjs: converts pages off the main thread.
import { parentPort } from 'node:worker_threads';
import { convertHtmlInProcess } from './html-markdown.mjs';

parentPort.on('message', async ({ id, html, options }) => {
  try {
    parentPort.postMessage({ id, result: await convertHtmlInProcess(html, options) });
  } catch (error) {
    parentPort.postMessage({ id, error: String((error && error.message) || error) });
  }
});
