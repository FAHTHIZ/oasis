import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { enableDebug, debugLog, disableDebug } from '../src/debug-log.mjs';
import { redactSecrets } from '../src/auto-memory.mjs';
import { redactArtifactText } from '../src/artifacts.mjs';
import { redactApprovalSecrets } from '../src/approval-language.mjs';
import { toOpenAIRecord } from '../src/trajectories.mjs';

// Fixtures are split so repository secret scanning does not flag them.
// Regression: the debug log, trajectories/session previews (auto-memory
// redactor), artifacts and approval text each kept their own shorter list, so
// Stripe, Groq, Hugging Face, GitLab, npm and xAI keys, URL passwords, JWTs,
// private keys and .env assignments were written to disk in clear text even
// though the secret shield recognised them.
const SECRETS = {
  stripe: 'sk_' + 'live_51QzR8vNm2Kp7Lw4Xc9Bt6Hy3',
  groq: 'gsk' + '_Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8Pe2Uo7Ii4Mm',
  huggingface: 'hf' + '_Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8',
  gitlab: 'glpat' + '-Qz8Rv2Nm7Kp4Lw9Xc6Bt3',
  npm: 'npm' + '_Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8Pe2',
  xai: 'xai' + '-Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8Pe2Uo7Ii4MmQz8Rv2Nm7Kp4',
  githubOauth: 'gho' + '_Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8Pe2',
  aws: 'AKIA' + 'QZ8RV2NM7KP4LW9X',
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiJxejhydjJubTcifQ.Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8',
  urlPassword: 'Sup3rS3cretPw'
};
const corpus = [
  'STRIPE=' + SECRETS.stripe, 'groq ' + SECRETS.groq, 'hf ' + SECRETS.huggingface, 'gitlab ' + SECRETS.gitlab,
  'npm ' + SECRETS.npm, 'xai ' + SECRETS.xai, 'gh ' + SECRETS.githubOauth, 'aws ' + SECRETS.aws, 'jwt ' + SECRETS.jwt,
  'DATABASE_URL=postgres://admin:' + SECRETS.urlPassword + '@db.internal:5432/app',
  'aws_secret_access_key = wJalrXUtnFQz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAqz8Rv2Nm7Kp4Lw9X\n-----END RSA PRIVATE KEY-----',
  'Authorization: Bearer qz8rv2nm7kp4lw9xc6bt3hy1'
].join('\n');
const values = [...Object.values(SECRETS), 'wJalrXUtnFQz8Rv2', 'MIIEowIBAAKCAQEAqz8', 'qz8rv2nm7kp4lw9xc6bt3hy1'];
const assertClean = (label, text) => { for (const value of values) assert.equal(String(text).includes(value), false, label + ' kept ' + value.slice(0, 12)); };

test('every persisted-text redactor covers what the secret shield recognises', () => {
  assertClean('auto memory / sessions', redactSecrets(corpus).text);
  assertClean('artifacts', redactArtifactText(corpus));
  assertClean('approval text', redactApprovalSecrets(corpus));
  assert.match(redactSecrets('see src/app.js, version 1.2.3, sha 4f9a1c2b').text, /src\/app\.js, version 1\.2\.3, sha 4f9a1c2b/, 'ordinary text is untouched');
});

test('the debug log redacts tool arguments, including a multi-line .env body', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-redact-debug-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'debug.txt');
  enableDebug({ file });
  try {
    debugLog('tools', 'write_file ok', { path: '.env', content: corpus });
    debugLog('tools', 'run_command ok', corpus);
  } finally { disableDebug(); }
  const log = await readFile(file, 'utf8');
  assert.match(log, /write_file ok/);
  assertClean('debug log', log);
});

test('trajectory export redacts secrets inside JSON tool-call arguments', () => {
  const record = toOpenAIRecord({ messages: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '.env', content: corpus }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: corpus }
  ] });
  assertClean('trajectory', JSON.stringify(record));
  assert.equal(JSON.parse(record.messages[0].tool_calls[0].function.arguments).path, '.env');
});

test('shared audit redaction masks short CLI credentials in persisted and exported data', async (t) => {
  const token = 'plainDebugCliCredentialValue';
  const apiKey = 'plainStructuredApiKeyValue';
  const command = 'deploy --token ' + token + ' --region ap-southeast-1';
  const args = ['--api-key', apiKey, '--limit', '10'];

  assert.doesNotMatch(redactSecrets(command).text, /plainDebugCliCredentialValue/);
  assert.doesNotMatch(redactArtifactText(command), /plainDebugCliCredentialValue/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-redact-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'debug.txt');
  enableDebug({ file });
  try {
    debugLog('tools', 'run_command', { command, args });
  } finally {
    disableDebug();
  }
  const log = await readFile(file, 'utf8');
  assert.doesNotMatch(log, /plainDebugCliCredentialValue|plainStructuredApiKeyValue/);
  assert.match(log, /ap-southeast-1/);
  assert.match(log, /--limit/);
  assert.match(log, /10/);

  const record = toOpenAIRecord({ messages: [
    { role: 'assistant', content: '', tool_calls: [{
      id: 'cli-1',
      type: 'function',
      function: { name: 'run_command', arguments: JSON.stringify({ command, args }) }
    }] }
  ] });
  assert.doesNotMatch(JSON.stringify(record), /plainDebugCliCredentialValue|plainStructuredApiKeyValue/);
  assert.match(JSON.stringify(record), /ap-southeast-1/);
});
