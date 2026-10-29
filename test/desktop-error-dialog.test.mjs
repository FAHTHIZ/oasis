import test from 'node:test';
import assert from 'node:assert/strict';
import { showErrorWithCopy } from '../desktop/error-dialog.mjs';

function harness(response = 1, clipboardError = false) {
  const calls = [];
  const dialog = { async showMessageBox(window, options) { calls.push({ window, options }); return { response }; } };
  const clipboard = { writeText(value) { if (clipboardError) throw new Error('clipboard unavailable'); calls.push({ copiedText: value }); } };
  return { calls, dialog, clipboard };
}

test('desktop error dialog offers a copy action and copies the selected details', async () => {
  const h = harness(0);
  const result = await showErrorWithCopy({ ...h, title: 'OASIS could not start', message: 'Try again', detail: 'EACCES: permission denied' });
  assert.equal(result.copied, true);
  assert.deepEqual(h.calls[0].options.buttons, ['Copy details', 'Close']);
  assert.match(h.calls[1].copiedText, /EACCES: permission denied/);
});

test('desktop error details redact API keys before showing or copying them', async () => {
  const h = harness(0);
  await showErrorWithCopy({ ...h, title: 'Error', message: 'Failed', detail: 'token=sk-proj-12345678901234567890' });
  assert.match(h.calls[0].options.detail, /\[redacted\]/);
  assert.doesNotMatch(h.calls[1].copiedText, /sk-proj-12345678901234567890/);
});

test('closing the desktop error dialog does not copy details', async () => {
  const h = harness(1);
  const result = await showErrorWithCopy({ ...h, title: 'Error', message: 'Failed', detail: 'Details' });
  assert.equal(result.copied, false);
  assert.equal(h.calls.some((call) => Object.hasOwn(call, 'copiedText')), false);
});

test('copy failure gives a plain-language manual-copy fallback', async () => {
  const h = harness(0, true);
  const result = await showErrorWithCopy({ ...h, title: 'Error', message: 'Failed', detail: 'Details' });
  assert.equal(result.copied, false);
  assert.match(h.calls[1].options.message, /select and copy/i);
});
