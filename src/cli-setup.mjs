import { getProvider, providerApiKey, providerForEndpoint, providerRegistry } from './provider-registry.mjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { defaultCloudBaseURL } from './cloud-providers.mjs';
import { loadConfig, saveConfig, DEFAULT_BASE_URL, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_MODEL, validateBaseUrl, validateProtocol, isLoopbackUrl, resolveSetupProviderPreset, inferSetupProviderPreset, shouldPromptForProviderBaseURL } from './config.mjs';
import { testProviderConnection } from './agent.mjs';
import { discoverLocalOllamaModels } from './ollama-discovery.mjs';
import { parsePaste } from '../app/core/connect.mjs';

// Model provider setup: oasis setup, oasis connect, and the first-run check.
// The terminal prompt helpers live in cli.mjs (they pause the turn key reader).
let askLine = async () => { throw new Error('Setup prompts are not configured.'); };
let askSecret = askLine;
export function configureSetupPrompts(prompts) { ({ askLine, askSecret } = prompts); }

// Hardware-aware setup: detect this computer and its local model servers, then
// save the best working route. Only a route that answers a real test request is
// saved; anything else prints the recommendation and the next step.
export async function autoSetup(root, { dryRun = false } = {}) {
  const { profileThisComputer, describeRecommendation } = await import('./hardware.mjs');
  stdout.write('\nOASIS automatic setup — checking this computer…\n');
  let current = null;
  try { current = await loadConfig(); } catch {}
  const rec = await profileThisComputer({ configured: Boolean(current && current.configured) });
  stdout.write(describeRecommendation(rec) + '\n');
  const primary = rec.primary;
  if (primary.route !== 'local') {
    stdout.write(primary.route === 'local-install'
      ? '\nInstall Ollama and pull the model above, then run oasis setup --auto again.\n'
      : '\nRun oasis setup to connect a hosted model with an API key.\n');
    return rec;
  }
  if (dryRun) { stdout.write('\n--dry-run: nothing was saved.\n'); return rec; }
  const candidate = { protocol: primary.protocol, baseURL: primary.baseURL, model: primary.model, apiKey: '', ...(rec.settings.contextWindow ? { contextWindow: rec.settings.contextWindow } : {}) };
  stdout.write('\nTesting ' + primary.serverName + ' with ' + primary.model + ' (local models can take a minute to load)…\n');
  try {
    await testProviderConnection(candidate, { timeoutMs: 180000 });
  } catch (error) {
    stdout.write('The test request failed: ' + (error && error.message || error) + '\nNothing was saved. Check the server, then run oasis setup --auto again, or run oasis setup to choose manually.\n');
    process.exitCode = 1;
    return rec;
  }
  const configPath = await saveConfig(candidate);
  stdout.write('Saved: ' + primary.model + ' via ' + primary.serverName + (candidate.contextWindow ? ' (context window ' + candidate.contextWindow + ' tokens)' : '') + ' → ' + configPath + '\nNext: run oasis in a project folder, or oasis web --open.\n');
  return rec;
}

export async function configureProvider(root = process.cwd(), options = {}) {
  stdout.write('\nOasis setup — choose and verify your model provider\n');
  stdout.write('A successful model response is required before settings are saved or coding tools are used. Presets include OpenAI, Anthropic, OpenRouter, Gemini, local Ollama, AWS Bedrock, Google Vertex AI, and Microsoft Foundry.\n');
  const rl = createInterface({ input: stdin, output: stdout });
  let protocol, baseURL, model, presetName;
  const presets = {
    ...Object.fromEntries(['openai', 'anthropic', 'openrouter', 'gemini', 'ollama'].map((id) => {
      const entry = getProvider(id);
      return [id, { protocol: entry.protocol, baseURL: entry.baseURL, model: entry.model }];
    })),
    bedrock: { protocol: 'bedrock', baseURL: defaultCloudBaseURL('bedrock', process.env), model: process.env.ANTHROPIC_MODEL || '' },
    vertex: { protocol: 'vertex', baseURL: defaultCloudBaseURL('vertex', process.env), model: process.env.ANTHROPIC_MODEL || '' },
    foundry: { protocol: 'foundry', baseURL: (() => { try { return defaultCloudBaseURL('foundry', process.env); } catch { return ''; } })() || 'https://RESOURCE.services.ai.azure.com/anthropic', model: process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '' }
  };
  const chooseApiPreset = async (preferredPreset) => {
    stdout.write('\nChoose your API-key provider:\n');
    stdout.write('  1. OpenAI\n  2. Anthropic\n  3. OpenRouter\n  4. Gemini\n  5. Other / compatible endpoint\n');
    const preferred = ({ openai: '1', anthropic: '2', openrouter: '3', gemini: '4', custom: '5' })[preferredPreset] || '1';
    const answer = (await rl.question('Choose [1/2/3/4/5] (default ' + preferred + '): ')).trim().toLowerCase() || preferred;
    const providers = { '1': 'openai', '2': 'anthropic', '3': 'openrouter', '4': 'gemini', '5': 'custom' };
    const selected = providers[answer] || (['openai', 'anthropic', 'openrouter', 'gemini', 'custom'].includes(answer) ? answer : '');
    if (!selected) throw new Error('Choose a number from 1 to 5 for the API-key provider.');
    return selected;
  };
  try {
    const currentConfig = options.defaultPreset === undefined
      ? await loadConfig().catch(() => null)
      : null;
    const defaultPreset = options.defaultPreset === undefined
      ? inferSetupProviderPreset(currentConfig)
      : resolveSetupProviderPreset(options.defaultPreset);
    if (options.skipPresetPrompt) {
      presetName = options.chooseKeyProvider ? await chooseApiPreset(defaultPreset) : defaultPreset;
    } else {
      stdout.write('\nChoose how you want to connect OASIS:\n');
      stdout.write('  1. I have an API key\n');
      stdout.write('  2. Use a model on this computer (Ollama)\n');
      stdout.write('  3. Advanced provider or custom endpoint\n');
      const defaultChoice = defaultPreset === 'ollama' ? '2'
        : ['bedrock', 'vertex', 'foundry', 'custom'].includes(defaultPreset) ? '3' : '1';
      const answer = (await rl.question('Choose [1/2/3] (default ' + defaultChoice + '): ')).trim().toLowerCase() || defaultChoice;
      const directPresets = ['openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'bedrock', 'vertex', 'foundry', 'custom'];
      if (directPresets.includes(answer)) {
        // Keep accepting named presets for existing scripts and experienced users.
        presetName = answer;
      } else if (answer === '2') {
        presetName = 'ollama';
      } else if (answer === '1') {
        presetName = await chooseApiPreset(defaultPreset);
      } else if (answer === '3') {
        stdout.write('\nChoose an advanced provider:\n');
        stdout.write('  1. AWS Bedrock\n  2. Google Vertex AI\n  3. Microsoft Foundry\n  4. Custom / compatible endpoint\n');
        const advancedDefault = ({ bedrock: '1', vertex: '2', foundry: '3', custom: '4' })[defaultPreset] || '4';
        const advancedAnswer = (await rl.question('Choose [1/2/3/4] (default ' + advancedDefault + '): ')).trim().toLowerCase() || advancedDefault;
        const advancedProviders = { '1': 'bedrock', '2': 'vertex', '3': 'foundry', '4': 'custom' };
        presetName = advancedProviders[advancedAnswer] || (['bedrock', 'vertex', 'foundry', 'custom'].includes(advancedAnswer) ? advancedAnswer : '');
        if (!presetName) throw new Error('Choose a number from 1 to 4 for the advanced provider.');
      } else {
        throw new Error('Choose 1, 2, or 3. No provider settings were changed.');
      }
    }
    if (shouldPromptForProviderBaseURL(presetName)) {
      protocol = validateProtocol((await rl.question('Protocol [openai-responses / anthropic / openai-compatible / bedrock / vertex / foundry] (default openai-responses): ')).trim().toLowerCase() || 'openai-responses');
      const defaultBase = protocol === 'bedrock' || protocol === 'vertex' || protocol === 'foundry' ? defaultCloudBaseURL(protocol, process.env) : protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
      baseURL = (await rl.question('Base URL [' + defaultBase + ']: ')).trim() || defaultBase;
      const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : '');
      const modelPrompt = defaultModel ? 'Model name [' + defaultModel + ']: ' : 'Model name (exact model ID required): ';
      model = (await rl.question(modelPrompt)).trim() || defaultModel;
    } else {
      const selected = presets[presetName];
      if (!selected) throw new Error('Unknown provider preset. Choose openai, anthropic, openrouter, gemini, ollama, bedrock, vertex, foundry, or custom.');
      protocol = selected.protocol;
      baseURL = selected.baseURL;
      model = selected.model;
      if (presetName === 'ollama') {
        let detected = await discoverLocalOllamaModels();
        if (detected.available && detected.models.length) {
          stdout.write('Ollama is running. Installed models: ' + detected.models.join(', ') + '\n');
          model = detected.models[0];
        } else {
          // Keep the setup flow alive so a beginner can install/start Ollama in
          // another terminal and retry instead of being forced to guess an ID.
          while (!detected.available || !detected.models.length) {
            stdout.write(detected.message + '\n');
            stdout.write('Install/start Ollama from https://ollama.com/download. If it is running but has no model, use another terminal to run: ollama pull <model-name>\n');
            const answer = (await rl.question('Enter a model ID to continue, press Enter to check again, or type later to stop: ')).trim();
            if (/^(?:later|skip|cancel)$/i.test(answer)) {
              throw new Error('Local model setup was stopped. No provider settings were changed. Install and start Ollama, then run oasis setup again.');
            }
            if (answer) {
              model = answer;
              break;
            }
            detected = await discoverLocalOllamaModels();
          }
          if (detected.available && detected.models.length) {
            stdout.write('Ollama is running. Installed models: ' + detected.models.join(', ') + '\n');
            model = detected.models[0];
          }
        }
      }
      stdout.write('Using the standard ' + presetName + ' endpoint. To use a different URL, choose Advanced > Custom.\n');
      const modelPrompt = model ? 'Model name [' + model + ']: ' : 'Model name (exact model ID required, after installing a model): ';
      model = (await rl.question(modelPrompt)).trim() || model;
    }
    if (!model) throw new Error('Enter the exact model name supported by this provider before continuing.');
  } finally { rl.close(); }
  protocol = validateProtocol(protocol);
  baseURL = validateBaseUrl(baseURL);
  const existing = await loadConfig().catch(() => ({ apiKey: '', baseURL: '', protocol: '' }));
  let apiKey = '';
  const localEndpoint = isLoopbackUrl(baseURL);
  if (protocol === 'foundry') {
    stdout.write('Microsoft Foundry uses ANTHROPIC_FOUNDRY_AUTH_TOKEN, or an API key, or az login (Entra ID). Enter the model deployment name as the model.\n');
    apiKey = await askSecret('Foundry API key (input hidden; leave empty to use az login or ANTHROPIC_FOUNDRY_AUTH_TOKEN): ');
    if (!apiKey) apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || '';
  } else if (protocol === 'bedrock' || protocol === 'vertex') {
    stdout.write(protocol === 'bedrock'
      ? 'Bedrock uses AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or AWS_PROFILE. Region: ' + (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1') + '.\n'
      : 'Vertex uses GOOGLE_OAUTH_ACCESS_TOKEN or gcloud auth print-access-token. Project: ' + (process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '(set ANTHROPIC_VERTEX_PROJECT_ID)') + '.\n');
  } else if (!localEndpoint || presetName === 'custom') {
    const label = localEndpoint ? 'Optional local endpoint key' : (protocol === 'anthropic' ? 'ANTHROPIC API key' : 'API key');
    apiKey = await askSecret(label + ' (input hidden; Enter keeps a key only if the endpoint is unchanged, otherwise use a matching environment variable): ');
    if (!apiKey && existing.baseURL === baseURL && existing.protocol === protocol) apiKey = existing.apiKey || '';
    if (localEndpoint) {
      if (!apiKey) apiKey = process.env.OASIS_LOCAL_API_KEY || '';
    } else {
      const host = new URL(baseURL).hostname.toLowerCase();
      // The registry knows each provider's key variables; ollama.com (Ollama's
      // hosted API) shares OLLAMA_API_KEY with the local server entry.
      const knownProvider = getProvider(providerForEndpoint(baseURL));
      const providerEnvKey = knownProvider ? providerApiKey(knownProvider, process.env) : (host === 'ollama.com' ? process.env.OLLAMA_API_KEY : '');
      if (!apiKey) apiKey = process.env.OASIS_API_KEY || providerEnvKey || (protocol === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || '';
    }
  }
  stdout.write('\nTesting tool calling with an inert validation probe (the probe will not be executed)...\n');
  await testProviderConnection({ protocol, baseURL, model, apiKey }, { timeoutMs: 30000 });
  const configPath = await saveConfig({ protocol, baseURL, model, apiKey });
  stdout.write('Provider responded successfully. Saved settings to ' + configPath + '\n');
  stdout.write('Protocol: ' + protocol + '\n');
  stdout.write('Authentication: ' + (apiKey ? 'configured' : (isLoopbackUrl(baseURL) ? 'local endpoint; no API key required' : 'not configured')) + '\n');
  stdout.write('The provider is verified. Oasis can now inspect workspaces and use approved tools.\n');
}

// Paste-to-connect in the terminal: the same smart connect the app uses. Works
// out the provider from a key, model link or local server address, picks the
// best tool-calling model, keeps the next ones as automatic backups and saves.
async function connectFromTerminalPaste(text) {
  const { connectFromPaste } = await import('./provider-connect.mjs');
  let last = '';
  const result = await connectFromPaste(text, {
    onStatus: (status) => {
      const line = String(status && status.text || status || '').trim();
      if (!line || line === last || status && status.step === 'download' && last.startsWith(line.split(' — ')[0])) { if (status && status.step === 'download') last = line; return; }
      last = line;
      stdout.write('  ' + line + '\n');
    }
  });
  const configPath = await saveConfig(result.config);
  const backups = result.config.fallbackModel ? result.config.fallbackModel.split(',').filter(Boolean) : [];
  stdout.write('Locked in ' + result.config.model + ' on ' + result.label + '.' + (backups.length ? ' ' + backups.length + ' backup model' + (backups.length === 1 ? '' : 's') + ' ready if it runs out.' : '') + '\n');
  stdout.write('Saved to ' + configPath + (result.masked ? ' (key ' + result.masked + ')' : '') + '.\n');
  if (result.githubToken) stdout.write('A GitHub token was in the paste too. It was not saved; OASIS uses your git login for GitHub.\n');
  return result;
}

export async function pasteFirstSetup(root, { announce = true } = {}) {
  if (announce) {
    stdout.write('\nConnect a model. Paste an API key (OpenAI, Anthropic, OpenRouter, Gemini, Groq, Hugging Face and more),\n');
    stdout.write('a model link, or a local server address like http://localhost:11434. OASIS works out the rest.\n');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let text;
    try { text = (await askSecret('Paste here (hidden; Enter for other options, "later" to skip): ')).trim(); }
    catch (error) { if (/cancel/i.test(String(error && error.message))) return 'skipped'; return 'menu'; }
    if (!text) return 'menu';
    if (/^(?:later|skip|q|quit|exit|\/exit|\/quit|n|no)$/i.test(text)) { stdout.write('Setup skipped. Run oasis connect when you are ready.\n'); return 'skipped'; }
    try {
      await connectFromTerminalPaste(text);
      return 'connected';
    } catch (error) {
      stdout.write('Could not connect: ' + redactSecretText(String(error && error.message || error), text) + '\n');
      if (attempt < 2) stdout.write('Try again, or press Enter for other options.\n');
    }
  }
  return 'menu';
}

export function redactSecretText(message, secret) {
  let out = message;
  for (const part of String(secret || '').split(/\s+/)) if (part.length >= 12) out = out.split(part).join('[redacted]');
  return out.slice(0, 1200);
}


const CONNECT_USAGE = [
  'Usage: oasis connect [KEY | MODEL LINK | SERVER ADDRESS]',
  '       oasis connect --from-env [PROVIDER]',
  '',
  'Paste an API key, a model page link (Hugging Face, OpenRouter, Ollama) or a',
  'local server address. OASIS works out the provider, lists its models, tests',
  'the best ones with a real tool call and saves the first that works, plus',
  'backups for when it runs out of credit.',
  '',
  'With nothing after it, OASIS asks for the paste so the key stays out of your',
  'shell history. --from-env uses a key already in the environment, such as',
  'GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY or OPENAI_API_KEY.'
].join('\n') + '\n';


// Provider keys already exported in the shell, in provider-registry order
// (built-ins first, then providers from user settings).
export function providerKeysInEnv(env = process.env) {
  const found = [];
  for (const [provider, entry] of Object.entries(providerRegistry({ env }))) {
    for (const name of entry.keyEnv || []) {
      const value = String(env[name] || '').trim();
      if (value && !found.some((item) => item.value === value)) { found.push({ provider, name, value }); break; }
    }
  }
  return found;
}

async function connectFromEnvironment(wanted = '') {
  const keys = providerKeysInEnv();
  const pick = wanted ? keys.find((item) => item.provider === wanted.toLowerCase() || item.name === wanted.toUpperCase()) : keys[0];
  if (!pick) {
    throw new Error(wanted
      ? 'No key for ' + wanted + ' in the environment. Known variables: ' + Object.values(providerRegistry()).flatMap((entry) => entry.keyEnv).join(', ') + '.'
      : 'No provider API key found in the environment (looked for ' + Object.values(providerRegistry()).flatMap((entry) => entry.keyEnv).join(', ') + ').');
  }
  if (keys.length > 1 && !wanted) stdout.write('Found keys for ' + keys.map((item) => item.provider).join(', ') + '; using ' + pick.name + ' (pass a provider name to choose).\n');
  else stdout.write('Using ' + pick.name + ' from the environment.\n');
  await connectFromTerminalPaste(pick.value);
}

export async function connectCommand(rest, root) {
  if (['--help', '-h', 'help'].includes(rest[0])) { stdout.write(CONNECT_USAGE); return; }
  if (rest[0] === '--from-env') { await connectFromEnvironment(rest[1] || ''); return; }
  const inline = rest.join(' ').trim();
  if (inline) {
    await connectFromTerminalPaste(inline);
    // Only a pasted key belongs out of shell history; an address or link does not.
    if (parsePaste(inline).keys.length) stdout.write('Tip: paste at the prompt next time (run oasis connect with nothing after it) so the key stays out of your shell history.\n');
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    const piped = Buffer.concat(chunks).toString('utf8').trim();
    if (!piped && providerKeysInEnv().length) { await connectFromEnvironment(); return; }
    if (!piped) throw new Error('Usage: oasis connect, then paste a model API key, a model link or a local server address (or run oasis connect --help).');
    await connectFromTerminalPaste(piped);
    return;
  }
  const outcome = await pasteFirstSetup(root);
  if (outcome === 'menu') await configureProvider(root);
}

export async function ensureModelProviderSetup(root, options = {}) {
  let configured = false;
  try { configured = Boolean((await loadConfig()).configured); } catch {}
  if (configured) return true;
  if (!stdin.isTTY || !stdout.isTTY) return false;

  if (options.announce !== false) stdout.write('\nNo model is connected yet.\n');
  if (typeof stdin.setRawMode === 'function') {
    const outcome = await pasteFirstSetup(root);
    if (outcome === 'connected') return true;
    if (outcome === 'skipped') return false;
  }
  stdout.write('\n  1. I have an API key (OpenAI, Anthropic, OpenRouter, Gemini, or a custom provider)\n');
  stdout.write('  2. Use a model on this computer (Ollama; smaller models may be weaker)\n');
  stdout.write('  3. Set this up later\n');
  const choices = { '1': 'openai', '2': 'ollama' };
  let preset = null;
  for (let attempt = 0; attempt < 3 && !preset; attempt++) {
    let answer;
    try { answer = (await askLine('Choose [1/2/3] (default 1): ')).trim().toLowerCase() || '1'; }
    catch { return false; }
    if (['3', 'later', 'n', 'no', 'skip', 'q', 'quit', 'exit', '/exit', '/quit'].includes(answer)) {
      stdout.write('Setup skipped. Run oasis setup when you are ready.\n');
      return false;
    }
    preset = choices[answer] || null;
    if (!preset) stdout.write(attempt < 2 ? 'Type 1, 2 or 3 and press Enter (3 sets this up later).\n' : 'No setup was run. Run oasis setup when you are ready.\n');
  }
  if (!preset) return false;
  try {
    await configureProvider(root, { defaultPreset: preset, skipPresetPrompt: true, chooseKeyProvider: preset === 'openai' });
  } catch (error) {
    stdout.write('Guided setup did not complete: ' + String(error && error.message || error) + '. Nothing new was saved unless the provider test succeeded. Run oasis setup to try again.\n');
  }
  try { return Boolean((await loadConfig()).configured); } catch { return false; }
}
