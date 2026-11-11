// Claude Code model aliases: opus, sonnet, haiku, fable, best, opusplan and the [1m] suffix.
// Aliases resolve at request time, so `--model opus`, `/model sonnet`, settings "model",
// agent front matter and the advisor all accept them. Pin a version with the
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL variables.
const FAMILY_DEFAULTS = {
  anthropic: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' },
  // Sonnet 5.5 and Haiku 5.5 are on Bedrock, Google Cloud and Foundry under these ids
  // (platform.claude.com/docs/en/about-claude/models/overview). Foundry's opus alias
  // stays on 4.6, as in Claude Code's model catalog.
  vertex: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' },
  bedrock: { opus: 'us.anthropic.claude-opus-5-5', sonnet: 'us.anthropic.claude-sonnet-5-5', haiku: 'us.anthropic.claude-haiku-5-5', fable: 'us.anthropic.claude-fable-5-1' },
  foundry: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' }
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
//
// Claude Code's matching: an id entry also permits ids that extend it with another segment
// ("claude-opus-5" permits claude-opus-5-5) unless options.match is "exact"; dated, Bedrock and
// gateway spellings compare by their canonical name. options.denied (managed deniedModels)
// blocks a family, a version in every spelling, or (for an id without a minor version) later
// minors too; "claude-opus-5-0" blocks Opus 5 alone.
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

export function canonicalClaudeId(model, options = {}) {
  const raw = String(model || '').trim();
  if (!raw) return null;
  let name = resolveModelAlias(raw, { protocol: options.protocol, env: options.env || process.env }).toLowerCase();
  name = name.replace(/\[1m\]$/, '').split('/').pop();
  name = name.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '').replace(/[@-]\d{8}$/, '');
  return /^claude-[a-z0-9.-]+$/.test(name) ? name : null;
}

const dashed = (value) => String(value || '').replace(/\./g, '-');

export function modelDenied(model, denied, options = {}) {
  if (!Array.isArray(denied) || !denied.length) return false;
  const raw = String(model || '').trim().toLowerCase().replace(/\[1m\]$/, '');
  if (!raw) return false;
  const resolved = String(resolveModelAlias(raw, options)).toLowerCase();
  const canonical = dashed(canonicalClaudeId(raw, options) || resolved);
  return denied.some((item) => {
    let entry = String(item || '').trim().toLowerCase().replace(/\[1m\]$/, '');
    if (!entry || ['best', 'opusplan', 'default'].includes(entry)) return false;
    if (FAMILIES.includes(entry)) return resolved.includes(entry) || raw.includes(entry);
    if (isModelAlias(entry)) entry = String(resolveModelAlias(entry, options)).toLowerCase();
    entry = dashed(canonicalClaudeId(entry, options) || entry);
    if (/^claude-[a-z]+-\d+-0$/.test(entry)) return canonical === entry || canonical === entry.slice(0, -2);
    return canonical === entry || (/^claude-[a-z]+-\d+$/.test(entry) && canonical.startsWith(entry + '-')) || resolved === entry;
  });
}

export function modelAllowed(model, list, options = {}) {
  const raw = String(model || '').trim().toLowerCase().replace(/\[1m\]$/, '');
  if (raw && raw !== 'default' && modelDenied(raw, options.denied, options)) return false;
  if (!Array.isArray(list) || !list.length) return true;
  if (!raw || raw === 'default') return true;
  const resolved = String(resolveModelAlias(raw, options)).toLowerCase();
  const canonical = dashed(canonicalClaudeId(raw, options) || resolved);
  return list.some((item) => {
    const entry = String(item || '').trim().toLowerCase().replace(/\[1m\]$/, '');
    if (!entry) return false;
    if (entry === raw || entry === resolved) return true;
    if (FAMILIES.includes(entry) && (resolved.includes(entry) || raw.includes(entry))) return true;
    if (isModelAlias(entry)) return String(resolveModelAlias(entry, options)).toLowerCase() === resolved;
    const id = dashed(canonicalClaudeId(entry, options) || entry);
    if (canonical === id) return true;
    return options.match !== 'exact' && canonical.startsWith(id + '-');
  });
}

// Claude Code's modelOverrides: { "claude-opus-4-6": "arn:aws:bedrock:..." } sends the mapped id
// to the provider. Keys match the resolved id or its canonical Claude name.
export function applyModelOverride(model, overrides, options = {}) {
  if (!overrides || typeof overrides !== 'object' || !model) return model;
  const resolved = String(model);
  if (typeof overrides[resolved] === 'string' && overrides[resolved].trim()) return overrides[resolved].trim();
  const canonical = canonicalClaudeId(resolved, options);
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const id = canonicalClaudeId(key, options) || key.toLowerCase();
    if (canonical && dashed(id) === dashed(canonical)) return value.trim();
  }
  return model;
}

export function modelRestrictionMessage(model, list, options = {}) {
  if (options.denied && modelDenied(model, options.denied, options)) return 'Model ' + model + ' is blocked by deniedModels in managed settings.';
  return 'Model ' + model + ' is not in availableModels (' + list.join(', ') + '). Pick one of those, or "default".';
}

// Fast mode (Claude Code /fast): faster output on supported Opus models for a higher per-token price.
// Opus 5.5 takes speed:"fast" directly; Opus 5 and 4.8 also need the fast-mode beta header.
export function fastModeRequest(model) {
  const id = String(model || '').toLowerCase();
  if (/opus-5-5|opus-5\.5/.test(id)) return { speed: 'fast' };
  if (/opus-5(?![-.]\d)|opus-4-8|opus-4\.8/.test(id)) return { speed: 'fast', beta: 'fast-mode-2026-02-01' };
  return null;
}
