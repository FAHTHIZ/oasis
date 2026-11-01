import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('VS Code Attach inserts @mentions for workspace images and refuses others', async (t) => {
  const warnings = [];
  let picked = [];
  const vscodeStub = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    window: { showOpenDialog: async () => picked, showWarningMessage: (message) => { warnings.push(message); } },
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest); };
  t.after(() => { Module._load = originalLoad; });
  const { ChatController } = require('../ide/vscode/src/chat-view.js');
  const root = path.resolve('/work/app');
  const controller = new ChatController({ getCommand: () => 'oasis', getCwd: () => root, getEnv: () => ({}) });
  const posted = [];
  const webview = { postMessage: (message) => posted.push(message) };
  picked = [{ fsPath: path.join(root, 'docs', 'shot.png') }, { fsPath: path.resolve('/elsewhere/x.png') }, { fsPath: path.join(root, 'my shot.png') }];
  await controller.attachImages(webview);
  assert.deepEqual(posted, [{ kind: 'insert', text: '@docs/shot.png' }]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /from this workspace only: x\.png/);
  assert.match(warnings[1], /Rename the image/);
  picked = undefined;
  await controller.attachImages(webview);
  assert.equal(posted.length, 1, 'Cancelling the picker inserts nothing.');
});
