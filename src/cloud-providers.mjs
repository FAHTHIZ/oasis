// Claude models on AWS Bedrock and Google Vertex AI. Both platforms use the Anthropic
// Messages format, so Oasis reuses its native Anthropic support and only changes the
// endpoint, a few body fields, and authentication.
//
// Bedrock  protocol "bedrock": AWS_BEARER_TOKEN_BEDROCK, or SigV4 with AWS_ACCESS_KEY_ID /
//          AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, or a profile in ~/.aws/credentials
//          (AWS_PROFILE). Region: AWS_REGION or AWS_DEFAULT_REGION (default us-east-1).
// Vertex   protocol "vertex": project from ANTHROPIC_VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT,
//          region from CLOUD_ML_REGION (default us-east5; "global" works too). Token from
//          OASIS_VERTEX_ACCESS_TOKEN / GOOGLE_OAUTH_ACCESS_TOKEN, else `gcloud auth print-access-token`.
// Foundry  protocol "foundry": Claude on Microsoft Foundry (Azure). Base URL from
//          ANTHROPIC_FOUNDRY_BASE_URL or https://{ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com/anthropic.
//          Auth: ANTHROPIC_FOUNDRY_AUTH_TOKEN (Entra bearer) > ANTHROPIC_FOUNDRY_API_KEY (x-api-key)
//          > `az account get-access-token --resource https://ai.azure.com`.
// Claude Code's CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 / CLAUDE_CODE_USE_FOUNDRY=1 also select these.
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const CLOUD_PROTOCOLS = ['bedrock', 'vertex', 'foundry'];
export const ANTHROPIC_FAMILY = new Set(['anthropic', 'bedrock', 'vertex', 'foundry']);

export function isAnthropicFamily(protocol) { return ANTHROPIC_FAMILY.has(protocol); }

export function cloudProtocolFromEnv(env) {
  if (/^(1|true)$/i.test(env.OASIS_USE_BEDROCK || env.CLAUDE_CODE_USE_BEDROCK || '')) return 'bedrock';
  if (/^(1|true)$/i.test(env.OASIS_USE_VERTEX || env.CLAUDE_CODE_USE_VERTEX || '')) return 'vertex';
  if (/^(1|true)$/i.test(env.OASIS_USE_FOUNDRY || env.CLAUDE_CODE_USE_FOUNDRY || '')) return 'foundry';
  return null;
}

export function awsRegion(env) { return env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1'; }
export function vertexRegion(env) { return env.CLOUD_ML_REGION || env.GOOGLE_CLOUD_REGION || 'us-east5'; }
export function vertexProject(env) { return env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || ''; }

export function foundryBaseURL(env) {
  if (env.ANTHROPIC_FOUNDRY_BASE_URL) return String(env.ANTHROPIC_FOUNDRY_BASE_URL).replace(/\/+$/, '');
  const resource = String(env.ANTHROPIC_FOUNDRY_RESOURCE || '').trim();
  if (!resource) return '';
  // Like Claude Code: the resource is a bare name, not a URL or host.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(resource)) throw new Error('ANTHROPIC_FOUNDRY_RESOURCE must be the Azure resource name only (for example my-resource). Put a full URL in ANTHROPIC_FOUNDRY_BASE_URL instead.');
  return 'https://' + resource + '.services.ai.azure.com/anthropic';
}

export function defaultCloudBaseURL(protocol, env) {
  if (protocol === 'foundry') return foundryBaseURL(env);
  if (protocol === 'bedrock') return 'https://bedrock-runtime.' + awsRegion(env) + '.amazonaws.com';
  const region = vertexRegion(env);
  return region === 'global' ? 'https://aiplatform.googleapis.com' : 'https://' + region + '-aiplatform.googleapis.com';
}

export function defaultCloudModel(protocol, env) {
  if (protocol === 'foundry') return env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || '';
  return env.ANTHROPIC_MODEL || '';
}

export function cloudCredentialsPresent(protocol, env) {
  if (protocol === 'bedrock') return Boolean(env.AWS_BEARER_TOKEN_BEDROCK || (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || env.AWS_PROFILE);
  if (protocol === 'foundry') return Boolean(env.ANTHROPIC_FOUNDRY_AUTH_TOKEN || env.ANTHROPIC_FOUNDRY_API_KEY || env.ANTHROPIC_FOUNDRY_RESOURCE || env.ANTHROPIC_FOUNDRY_BASE_URL);
  return Boolean(env.OASIS_VERTEX_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN || vertexProject(env));
}

// Endpoint for one request. Bedrock streams use a binary event format, so Oasis calls
// Bedrock without streaming; Vertex streams the normal Anthropic SSE events.
export function cloudEndpoint(config, env, stream) {
  const base = String(config.baseURL || defaultCloudBaseURL(config.protocol, env)).replace(/\/+$/, '');
  if (config.protocol === 'bedrock') return base + '/model/' + encodeURIComponent(config.model) + '/invoke';
  if (config.protocol === 'foundry') {
    if (!base) throw new Error('Microsoft Foundry needs a resource: set ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL).');
    return base + '/v1/messages';
  }
  const project = vertexProject(env);
  if (!project) throw new Error('Vertex AI needs a project: set ANTHROPIC_VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT.');
  return base + '/v1/projects/' + encodeURIComponent(project) + '/locations/' + encodeURIComponent(vertexRegion(env)) + '/publishers/anthropic/models/' + encodeURIComponent(config.model) + ':' + (stream ? 'streamRawPredict' : 'rawPredict');
}

// Turns an Anthropic Messages body into the platform's variant.
export function cloudBody(protocol, body) {
  if (protocol === 'foundry') return body; // standard Messages body; model is the deployment name
  const { model, ...rest } = body;
  if (protocol === 'bedrock') { delete rest.stream; return { anthropic_version: 'bedrock-2023-05-31', ...rest }; }
  return { anthropic_version: 'vertex-2023-10-16', ...rest };
}

export function cloudStreams(protocol) { return protocol === 'vertex' || protocol === 'foundry'; }

// ---------- AWS SigV4 ----------

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const rfc3986 = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());

export function signAwsRequest({ method = 'POST', url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const target = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()])), host: target.host, 'x-amz-date': amzDate };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((name) => name + ':' + all[name].replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = names.join(';');
  // Non-S3 services encode each path segment twice (the URL already holds it once).
  const canonicalUri = target.pathname.split('/').map((segment) => rfc3986(segment)).join('/') || '/';
  const query = [...target.searchParams.entries()].map(([key, value]) => [rfc3986(key), rfc3986(value)]).sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0).map(([key, value]) => key + '=' + value).join('&');
  const canonicalRequest = [method.toUpperCase(), canonicalUri, query, canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = day + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  const out = { ...headers, 'x-amz-date': amzDate, authorization: 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature };
  if (sessionToken) out['x-amz-security-token'] = sessionToken;
  return { headers: out, signature, canonicalRequest, stringToSign };
}

export async function awsCredentials(env) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || '' };
  const file = env.AWS_SHARED_CREDENTIALS_FILE || path.join(env.HOME || os.homedir(), '.aws', 'credentials');
  const profile = env.AWS_PROFILE || 'default';
  const text = await readFile(file, 'utf8').catch(() => '');
  let current = null;
  const found = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[(?:profile\s+)?([^\]]+)\]$/);
    if (section) { current = section[1].trim(); continue; }
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
    if (kv && current === profile) found[kv[1].toLowerCase()] = kv[2].trim();
  }
  if (found.aws_access_key_id && found.aws_secret_access_key) return { accessKeyId: found.aws_access_key_id, secretAccessKey: found.aws_secret_access_key, sessionToken: found.aws_session_token || '' };
  throw new Error('No AWS credentials found for Bedrock. Set AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_PROFILE with ~/.aws/credentials.');
}

// ---------- Google access token ----------

let cachedGoogleToken = null;

export async function googleAccessToken(env, runGcloud = defaultGcloud) {
  const direct = env.OASIS_VERTEX_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (direct) return direct;
  if (cachedGoogleToken && cachedGoogleToken.expires > Date.now()) return cachedGoogleToken.token;
  const token = (await runGcloud(env)).trim();
  if (!token) throw new Error('gcloud returned no access token. Run gcloud auth application-default login, or set GOOGLE_OAUTH_ACCESS_TOKEN.');
  cachedGoogleToken = { token, expires: Date.now() + 45 * 60 * 1000 };
  return token;
}

function defaultGcloud(env) {
  return new Promise((resolve, reject) => execFile('gcloud', ['auth', 'print-access-token'], { env, timeout: 20000 }, (error, stdout) => {
    if (error) reject(new Error('Vertex AI needs a Google access token: install gcloud and run gcloud auth login, or set GOOGLE_OAUTH_ACCESS_TOKEN. (' + error.message + ')'));
    else resolve(stdout);
  }));
}

// ---------- Microsoft Entra ID token (Foundry) ----------

let cachedAzureToken = null;

export async function azureAccessToken(env, runAz = defaultAz) {
  if (env.ANTHROPIC_FOUNDRY_AUTH_TOKEN) return env.ANTHROPIC_FOUNDRY_AUTH_TOKEN;
  if (cachedAzureToken && cachedAzureToken.expires > Date.now()) return cachedAzureToken.token;
  const token = (await runAz(env)).trim();
  if (!token) throw new Error('az returned no access token. Run az login, or set ANTHROPIC_FOUNDRY_API_KEY or ANTHROPIC_FOUNDRY_AUTH_TOKEN.');
  cachedAzureToken = { token, expires: Date.now() + 45 * 60 * 1000 };
  return token;
}

function defaultAz(env) {
  return new Promise((resolve, reject) => execFile('az', ['account', 'get-access-token', '--resource', 'https://ai.azure.com', '--query', 'accessToken', '-o', 'tsv'], { env, timeout: 20000, shell: process.platform === 'win32' }, (error, stdout) => {
    if (error) reject(new Error('Microsoft Foundry needs credentials: set ANTHROPIC_FOUNDRY_API_KEY or ANTHROPIC_FOUNDRY_AUTH_TOKEN, or install the Azure CLI and run az login. (' + error.message + ')'));
    else resolve(stdout);
  }));
}

// Final headers for a request; bodyText must be the exact bytes that will be sent.
export async function cloudHeaders(config, env, url, bodyText, base = {}) {
  const headers = { ...base };
  if (config.protocol === 'foundry') {
    headers['anthropic-version'] = '2023-06-01';
    delete headers['x-api-key'];
    const key = env.ANTHROPIC_FOUNDRY_API_KEY || config.apiKey;
    if (!env.ANTHROPIC_FOUNDRY_AUTH_TOKEN && key) headers['x-api-key'] = key;
    else headers.authorization = 'Bearer ' + await azureAccessToken(env);
    return headers;
  }
  delete headers['x-api-key'];
  delete headers['anthropic-version'];
  if (config.protocol === 'vertex') {
    headers.authorization = 'Bearer ' + await googleAccessToken(env);
    return headers;
  }
  const bearer = env.AWS_BEARER_TOKEN_BEDROCK || config.apiKey;
  if (bearer) { headers.authorization = 'Bearer ' + bearer; return headers; }
  const credentials = await awsCredentials(env);
  return signAwsRequest({ method: 'POST', url, headers, body: bodyText, region: awsRegion(env), service: 'bedrock', ...credentials }).headers;
}
