// Claude Code model aliases: opus, sonnet, haiku, fable, best, opusplan and the [1m] suffix.
// Aliases resolve at request time, so `--model opus`, `/model sonnet`, settings "model",
// agent front matter and the advisor all accept them. Pin a version with the
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL variables.
const FAMILY_DEFAULTS = {
  anthropic: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' },
  vertex: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-4-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5-1' },
  bedrock: { opus: 'us.anthropic.claude-opus-5-5', sonnet: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', fable: 'us.anthropic.claude-fable-5-1' },
  foundry: { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5-1' }
};
export const MODEL_ALIASES = ['default', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'opus[1m]', 'sonnet[1m]', 'opusplan[1m]'];

export function isModelAlias(name) {
  return MODEL_ALIASES.includes(String(name || '').trim().toLowerCase());
}

function family(name, protocol, env) {
  const pinned = env['ANTHROPIC_DEFAULT_' + name.toUpperCase() + '_MODEL'];
  if (pinned) return String(pinned);
  const defaults = FAMILY_DEFAULTS[protocol];
  return defaults ? defaults[name] : null;
}

// Returns the concrete model id, or the input unchanged when it is not an alias or the
// provider has no Claude family (OpenAI-compatible endpoints keep the literal name
// unless an ANTHROPIC_DEFAULT_*_MODEL variable maps it).
export function resolveModelAlias(model, options = {}) {
  const raw = String(model || '').trim();
  const name = raw.toLowerCase().replace(/\[1m\]$/, '');
  if (!isModelAlias(raw)) return raw;
  const env = options.env || process.env;
  const protocol = options.protocol || 'anthropic';
  let resolved = null;
  if (name === 'opusplan') resolved = family(options.planMode ? 'opus' : 'sonnet', protocol, env);
  else if (name === 'best') resolved = family('fable', protocol, env) || family('opus', protocol, env);
  else if (name === 'default') resolved = env.ANTHROPIC_DEFAULT_MODEL && !isModelAlias(env.ANTHROPIC_DEFAULT_MODEL) ? env.ANTHROPIC_DEFAULT_MODEL : family('opus', protocol, env);
  else resolved = family(name, protocol, env);
  return resolved || raw;
}

// Claude Code's availableModels setting: a list of aliases and model ids users may pick
// with /model, --model, agent front matter or the advisor. "default" is always allowed.
// A family alias ("opus") allows every model of that family; an id allows itself and any
// alias that resolves to it.
export function modelAllowed(model, list, options = {}) {
  if (!Array.isArray(list) || !list.length) return true;
  const raw = String(model || '').trim().toLowerCase().replace(/\[1m\]$/, '');
  if (!raw || raw === 'default') return true;
  const resolved = String(resolveModelAlias(raw, options)).toLowerCase();
  return list.some((item) => {
    const entry = String(item || '').trim().toLowerCase().replace(/\[1m\]$/, '');
    if (!entry) return false;
    if (entry === raw || entry === resolved) return true;
    if (['opus', 'sonnet', 'haiku', 'fable'].includes(entry) && (resolved.includes(entry) || raw.includes(entry))) return true;
    return isModelAlias(entry) && String(resolveModelAlias(entry, options)).toLowerCase() === resolved;
  });
}

export function modelRestrictionMessage(model, list) {
  return 'Model ' + model + ' is not in availableModels (' + list.join(', ') + '). Pick one of those, or "default".';
}
