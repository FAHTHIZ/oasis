#!/usr/bin/env node
// Regenerates src/data/model-catalog.json, the offline snapshot of the models.dev
// catalog (https://models.dev, MIT) that ships with Oasis. Usage:
//   node scripts/update-model-catalog.mjs [path/to/api.json]
// Without a path it downloads https://models.dev/api.json.
import fs from 'node:fs';
import { MODEL_CATALOG_URL, trimCatalog } from '../src/model-catalog.mjs';

// Model makers, routers and major inference hosts. The per-user cache refreshed
// at runtime carries every models.dev provider.
const PROVIDERS = [
  'anthropic', 'openai', 'google', 'google-vertex', 'google-vertex-anthropic', 'xai', 'deepseek', 'moonshotai', 'moonshotai-cn',
  'zai', 'zhipuai', 'minimax', 'mistral', 'alibaba', 'cohere', 'perplexity', 'xiaomi', 'stepfun', 'openrouter', 'amazon-bedrock',
  'azure', 'github-copilot', 'groq', 'cerebras', 'togetherai', 'fireworks-ai', 'deepinfra', 'ollama-cloud', 'nvidia', 'vercel',
  'huggingface', 'novita-ai', 'baseten', 'sambanova', 'requesty', 'nebius', 'chutes', 'siliconflow'
];

const source = process.argv[2];
const raw = source
  ? JSON.parse(fs.readFileSync(source, 'utf8'))
  : await (await fetch(MODEL_CATALOG_URL, { headers: { accept: 'application/json' } })).json();
const providers = trimCatalog(raw, PROVIDERS);
const missing = PROVIDERS.filter((id) => !providers[id]);
if (missing.length) console.error('not in models.dev: ' + missing.join(', '));
const target = new URL('../src/data/model-catalog.json', import.meta.url);
fs.writeFileSync(target, JSON.stringify({ source: MODEL_CATALOG_URL, fetchedAt: new Date().toISOString(), providers }) + '\n');
const count = Object.values(providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
console.log('wrote ' + count + ' models from ' + Object.keys(providers).length + ' providers');
