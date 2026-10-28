import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signAwsRequest, awsCredentials, cloudEndpoint, cloudBody, googleAccessToken, cloudProtocolFromEnv } from '../src/cloud-providers.mjs';
import { loadConfig, validateProtocol } from '../src/config.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('SigV4 matches the AWS get-vanilla test vector', () => {
  const { signature, headers } = signAwsRequest({
    method: 'GET', url: 'https://example.amazonaws.com/', body: '', region: 'us-east-1', service: 'service',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z')
  });
  assert.equal(signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=/);
});

test('SigV4 double-encodes path segments such as Bedrock model IDs', () => {
  const { canonicalRequest } = signAwsRequest({ url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/' + encodeURIComponent('us.anthropic.claude:0') + '/invoke', body: '{}', region: 'us-east-1', service: 'bedrock', accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'tok' });
  assert.match(canonicalRequest, /\/model\/us\.anthropic\.claude%253A0\/invoke/);
  assert.match(canonicalRequest, /x-amz-security-token:tok/);
});

test('endpoints, bodies and env switches', () => {
  assert.equal(validateProtocol('bedrock'), 'bedrock');
  assert.equal(cloudProtocolFromEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'bedrock');
  assert.equal(cloudProtocolFromEnv({ OASIS_USE_VERTEX: 'true' }), 'vertex');
  assert.equal(cloudEndpoint({ protocol: 'bedrock', model: 'm:1', baseURL: '' }, { AWS_REGION: 'eu-west-1' }), 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/m%3A1/invoke');
  assert.equal(cloudEndpoint({ protocol: 'vertex', model: 'claude@1', baseURL: '' }, { ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: 'global' }, true), 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude%401:streamRawPredict');
  assert.throws(() => cloudEndpoint({ protocol: 'vertex', model: 'x' }, {}), /project/);
  assert.deepEqual(cloudBody('bedrock', { model: 'x', stream: true, max_tokens: 1 }), { anthropic_version: 'bedrock-2023-05-31', max_tokens: 1 });
  assert.deepEqual(cloudBody('vertex', { model: 'x', stream: true }), { anthropic_version: 'vertex-2023-10-16', stream: true });
});

test('AWS profile credentials and Google token sources', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-aws-'));
  const file = path.join(dir, 'credentials');
  await writeFile(file, '[default]\naws_access_key_id = A\naws_secret_access_key = B\n[work]\naws_access_key_id = C\naws_secret_access_key = D\naws_session_token = E\n');
  assert.deepEqual(await awsCredentials({ AWS_SHARED_CREDENTIALS_FILE: file, AWS_PROFILE: 'work' }), { accessKeyId: 'C', secretAccessKey: 'D', sessionToken: 'E' });
  await assert.rejects(awsCredentials({ AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'none') }), /No AWS credentials/);
  assert.equal(await googleAccessToken({ GOOGLE_OAUTH_ACCESS_TOKEN: 'g' }), 'g');
  assert.equal(await googleAccessToken({}, async () => 'from-gcloud\n'), 'from-gcloud');
});

test('loadConfig selects bedrock and vertex from env', async () => {
  const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'oasis-cfg-')), 'config.json');
  const bedrock = await loadConfig({ configPath, env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', ANTHROPIC_MODEL: 'us.anthropic.claude-x' } });
  assert.equal(bedrock.protocol, 'bedrock');
  assert.equal(bedrock.baseURL, 'https://bedrock-runtime.us-west-2.amazonaws.com');
  assert.equal(bedrock.configured, true);
  await assert.rejects(loadConfig({ configPath, env: { OASIS_PROTOCOL: 'bedrock' } }), /OASIS_MODEL/);
  const vertex = await loadConfig({ configPath, env: { OASIS_PROTOCOL: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'p', OASIS_MODEL: 'claude@1' } });
  assert.equal(vertex.baseURL, 'https://us-east5-aiplatform.googleapis.com');
  assert.equal(vertex.configured, true);
});

function fakeServer(t, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); reply(req, res); });
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: 'http://127.0.0.1:' + server.address().port, requests })));
}

test('a Bedrock turn is signed with SigV4 and parsed like Anthropic', async (t) => {
  const { base, requests } = await fakeServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', content: [{ type: 'text', text: 'hello from bedrock' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bedrock-'));
  const env = { ...process.env, AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'sess', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: '' };
  const session = await createSession({ root, config: { protocol: 'bedrock', baseURL: base, model: 'us.anthropic.claude:0', apiKey: '', configured: true, maxSteps: 3, maxToolCalls: 3, maxTokens: 100000 }, settings, bare: true });
  const result = await runAgentTurn(session, 'hi', { env, onDelta: () => {} });
  assert.match(JSON.stringify(result), /hello from bedrock/);
  const [request] = requests;
  assert.equal(request.url, '/model/us.anthropic.claude%3A0/invoke');
  assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(request.headers['x-amz-security-token'], 'sess');
  assert.equal(request.headers['x-api-key'], undefined);
  assert.equal(request.body.anthropic_version, 'bedrock-2023-05-31');
  assert.equal(request.body.model, undefined);
  assert.equal(request.body.stream, undefined);
  assert.ok(Array.isArray(request.body.messages));
});

test('a Vertex turn streams Anthropic SSE with a bearer token', async (t) => {
  const { base, requests } = await fakeServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'm', model: 'claude', usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello from vertex' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ];
    res.end(events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-vertex-'));
  const env = { ...process.env, GOOGLE_OAUTH_ACCESS_TOKEN: 'gtoken', ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLOUD_ML_REGION: 'us-east5' };
  const session = await createSession({ root, config: { protocol: 'vertex', baseURL: base, model: 'claude-x@1', apiKey: '', configured: true, maxSteps: 3, maxToolCalls: 3, maxTokens: 100000 }, settings, bare: true });
  let streamed = '';
  const result = await runAgentTurn(session, 'hi', { env, onDelta: (d) => { streamed += typeof d === 'string' ? d : (d && d.text) || ''; } });
  assert.match(JSON.stringify(result) + streamed, /hello from vertex/);
  const [request] = requests;
  assert.equal(request.url, '/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-x%401:streamRawPredict');
  assert.equal(request.headers.authorization, 'Bearer gtoken');
  assert.equal(request.body.anthropic_version, 'vertex-2023-10-16');
  assert.equal(request.body.stream, true);
  assert.equal(request.body.model, undefined);
});
