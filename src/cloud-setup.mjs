// /setup-bedrock and /setup-vertex (Claude Code wizards): detect credentials, region/project and
// model pins, show the plan, and on confirmation write them to the `env` block of user settings
// (applied at startup, like Claude's settings.json env). Secrets are never written: Bedrock API keys
// and Google credentials stay in your environment or credential files.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { updateUserSettings, userSettingsPath } from './settings.mjs';

const PIN_KEYS = { opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' };
const DEFAULT_PINS = {
  bedrock: { sonnet: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
  vertex: { sonnet: 'claude-sonnet-4-5@20250929', haiku: 'claude-haiku-4-5@20251001' }
};

export function parseSetupArgs(argument = '') {
  const out = { save: false, values: {} };
  for (const word of String(argument || '').trim().split(/\s+/).filter(Boolean)) {
    if (word === 'save' || word === '--yes' || word === '-y') { out.save = true; continue; }
    const match = /^--?([a-z-]+)=(.*)$/i.exec(word) || /^([a-z-]+)=(.*)$/i.exec(word);
    if (match) out.values[match[1].toLowerCase()] = match[2];
    else throw new Error('Unexpected argument "' + word + '". Use key=value pairs, for example region=us-west-2.');
  }
  return out;
}

async function awsProfiles(env) {
  const files = [env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config'), env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials')];
  const names = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const match of text.matchAll(/^\[(?:profile\s+)?([^\]\s]+)\]/gm)) names.add(match[1]);
  }
  return [...names];
}

function gcloudValue(key, env) {
  try {
    const run = spawnSync('gcloud', ['config', 'get-value', key], { encoding: 'utf8', timeout: 8000, env });
    const value = String(run.stdout || '').trim();
    return run.status === 0 && value && !/unset/i.test(value) ? value : '';
  } catch { return ''; }
}

// Returns { provider, env: {KEY: value}, notes: [...], problems: [...] }.
export async function cloudSetupPlan(provider, values = {}, env = process.env) {
  const plan = { provider, env: {}, notes: [], problems: [] };
  const pin = (family, fallback) => {
    const value = values[family] || env[PIN_KEYS[family]] || fallback;
    if (value) plan.env[PIN_KEYS[family]] = value;
  };
  if (provider === 'bedrock') {
    plan.env.CLAUDE_CODE_USE_BEDROCK = '1';
    plan.env.AWS_REGION = values.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
    const profiles = await awsProfiles(env);
    const profile = values.profile || env.AWS_PROFILE || (profiles.includes('default') ? '' : profiles[0] || '');
    if (profile) plan.env.AWS_PROFILE = profile;
    if (env.AWS_BEARER_TOKEN_BEDROCK) plan.notes.push('Auth: Bedrock API key from AWS_BEARER_TOKEN_BEDROCK (kept in your environment, not saved).');
    else if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) plan.notes.push('Auth: AWS access keys from your environment (not saved).');
    else if (profile || profiles.length) plan.notes.push('Auth: AWS profile ' + (profile || 'default') + ' from ~/.aws (profiles found: ' + profiles.join(', ') + '). Run aws sso login --profile ' + (profile || 'default') + ' if it uses SSO.');
    else plan.problems.push('No AWS credentials found: set AWS_BEARER_TOKEN_BEDROCK, AWS access keys, or configure a profile with aws configure / aws configure sso.');
    if (values.model) plan.env.ANTHROPIC_MODEL = values.model;
    pin('opus', ''); pin('sonnet', DEFAULT_PINS.bedrock.sonnet); pin('haiku', DEFAULT_PINS.bedrock.haiku);
    plan.notes.push('Model pins must be Bedrock model IDs or inference profile IDs enabled in ' + plan.env.AWS_REGION + ' (aws bedrock list-inference-profiles --region ' + plan.env.AWS_REGION + ').');
  } else if (provider === 'vertex') {
    plan.env.CLAUDE_CODE_USE_VERTEX = '1';
    const project = values.project || env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || gcloudValue('project', env);
    if (project) plan.env.ANTHROPIC_VERTEX_PROJECT_ID = project;
    else plan.problems.push('No Google Cloud project found: pass project=ID, or run gcloud config set project ID.');
    plan.env.CLOUD_ML_REGION = values.region || env.CLOUD_ML_REGION || env.GOOGLE_CLOUD_REGION || 'us-east5';
    const account = gcloudValue('account', env);
    if (env.OASIS_VERTEX_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN) plan.notes.push('Auth: access token from your environment (not saved).');
    else if (env.GOOGLE_APPLICATION_CREDENTIALS) plan.notes.push('Auth: service account file ' + env.GOOGLE_APPLICATION_CREDENTIALS + '.');
    else if (account) plan.notes.push('Auth: gcloud account ' + account + ' (run gcloud auth application-default login if requests fail).');
    else plan.problems.push('No Google credentials found: run gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS.');
    if (values.model) plan.env.ANTHROPIC_MODEL = values.model;
    pin('opus', ''); pin('sonnet', DEFAULT_PINS.vertex.sonnet); pin('haiku', DEFAULT_PINS.vertex.haiku);
    plan.notes.push('Enable the Claude models for project ' + (project || 'PROJECT') + ' in Vertex AI Model Garden first.');
  } else throw new Error('Unknown provider ' + provider);
  return plan;
}

export function describePlan(plan, env = process.env) {
  const lines = ['Settings to write to ' + userSettingsPath(env) + ' (env block):'];
  for (const [key, value] of Object.entries(plan.env)) lines.push('  ' + key + '=' + value);
  for (const note of plan.notes) lines.push('- ' + note);
  for (const problem of plan.problems) lines.push('! ' + problem);
  return lines.join('\n');
}

// Removes the other cloud switch so only one provider is active.
export async function saveCloudSetup(plan, env = process.env) {
  await updateUserSettings((settings) => {
    const next = { ...(settings.env || {}) };
    for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'OASIS_USE_BEDROCK', 'OASIS_USE_VERTEX', 'OASIS_USE_FOUNDRY']) delete next[key];
    Object.assign(next, plan.env);
    settings.env = next;
    return settings;
  }, env);
  return userSettingsPath(env);
}
