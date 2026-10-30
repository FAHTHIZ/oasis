import test from 'node:test';
import assert from 'node:assert/strict';
import { formatApprovalMessage, redactApprovalSecrets } from '../src/approval-language.mjs';

test('delete approvals explain which file will be removed and that a backup is created', () => {
  const result = formatApprovalMessage('Delete the workspace file build/output.js? Its current contents will be backed up first.');
  assert.equal(result.risky, true);
  assert.match(result.message, /WARNING — RISKY ACTION/);
  assert.match(result.message, /delete the file “build\/output\.js”/i);
  assert.match(result.message, /backup will be made first/i);
});

test('command approvals use plain words, preserve the command, and flag known destructive patterns', () => {
  const result = formatApprovalMessage('Run this command in the workspace?\n  rm -rf build\nHIGH RISK: this command deletes files.');
  assert.equal(result.risky, true);
  assert.match(result.message, /run this command in your project/i);
  assert.match(result.message, /rm -rf build/);
  assert.match(result.message, /read the command before you approve/i);
});

test('tool metadata is used for the same approval wording when it is available', () => {
  const result = formatApprovalMessage('A tool requests a command.', {
    tool: 'delete_file',
    input: { path: 'out/old.txt' }
  });
  assert.match(result.message, /“out\/old\.txt”/);
  assert.equal(result.risky, true);
});

test('package install approval explains the environment and third-party code risk', () => {
  const result = formatApprovalMessage('Install package left-pad using npm install left-pad\nThis changes your environment and may execute third-party installer scripts.');
  assert.equal(result.risky, true);
  assert.match(result.message, /left-pad/);
  assert.match(result.message, /third-party installer code/i);
});

test('approval text redacts common provider keys, bearer credentials, and key assignments', () => {
  const secrets = [
    'sk-ant-abcdefghijklmnop123456',
    'sk-abcdefghijklmnop123456789',
    'AIza012345678901234567890123',
    'ghp_123456789012345678901234',
    'github_pat_12345678901234567890'
  ];
  for (const secret of secrets) assert.doesNotMatch(redactApprovalSecrets('token=' + secret), new RegExp(secret));
  assert.match(redactApprovalSecrets('Authorization: Bearer abc.def.ghi'), /Authorization: Bearer \[redacted\]/i);
  assert.match(redactApprovalSecrets('api_key=do-not-show-me'), /api_key=\[redacted\]/i);
  assert.match(redactApprovalSecrets('{"apiKey":"json-secret"}'), /apiKey":"\[redacted\]/i);
  assert.match(redactApprovalSecrets('run --token super-secret-value'), /--token \[redacted\]/i);
});


test('credential redaction keeps a stable placeholder without malformed secret fragments', () => {
  const result = redactApprovalSecrets('Provider key sk-ant-abcdefghijklmnop123456; token=super-secret-value');
  assert.equal(result, 'Provider key [redacted secret]; token=[redacted]');
  assert.doesNotMatch(result, /\\[redacted\\]\\s*secret\\]/i);
});
