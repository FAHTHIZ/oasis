const HARD_SIGNALS = [
  /\b(?:security|authentication|authorization|permissions?|secrets?|credentials?|sandbox|threat model|prompt injection)\b/i,
  /\b(?:architect(?:ure)?|refactor|redesign|migration|migrate|upgrade|deployment|production|performance|concurrency|race condition|database|schema)\b/i,
  /\b(?:implement|build|create|add|remove|change|modify|rewrite|debug|fix|repair|test|tests|feature|workflow|integrat(?:e|ion))\b/i,
  /\b(?:multiple files|whole repository|entire repo|end.to.end|full product|across the project)\b/i,
  /\b(?:and then|as well as|in addition|several|multiple)\b/i
];

const EASY_SIGNALS = [
  /^(?:please\s+)?(?:explain|summari[sz]e|describe|list|find|locate|show|identify|where|what|how does|how do)\b/i,
  /\b(?:read.only|quick overview|brief overview|what does .+ do|where is .+ defined)\b/i
];

const MUTATION_SIGNALS = [
  /\b(?:edit|write|change|modify|create|add|remove|delete|fix|repair|implement|build|refactor|rename|move|update|upgrade|migrate|install|commit|push|deploy)\b/i,
  /\b(?:make|turn|convert)\s+.+\s+(?:into|to)\s+/i
];

/**
 * Conservative, deterministic routing. Only clearly read-only, low-risk requests
 * qualify for the cheaper model; unknown or change-oriented work stays on strong.
 */
export function classifyTask(prompt, hint = null) {
  const text = String(prompt || '').trim();
  const explicit = String(hint || '').toLowerCase();
  if (['small', 'easy'].includes(explicit)) return { tier: 'easy', reason: 'benchmark task marked small' };
  if (['large', 'medium', 'hard'].includes(explicit)) return { tier: 'strong', reason: 'benchmark task is not marked small' };
  if (!text) return { tier: 'strong', reason: 'empty task defaults to strong model' };
  const hardSignal = HARD_SIGNALS.find((pattern) => pattern.test(text));
  if (hardSignal) return { tier: 'strong', reason: 'task contains a change, complexity, or safety signal' };
  if (text.length > 1200 || text.split(/\s+/).length > 180) {
    return { tier: 'strong', reason: 'long or detailed request defaults to strong model' };
  }
  const mutation = MUTATION_SIGNALS.some((pattern) => pattern.test(text));
  const easySignal = EASY_SIGNALS.some((pattern) => pattern.test(text));
  if (easySignal && !mutation) return { tier: 'easy', reason: 'short, clearly read-only request' };
  return { tier: 'strong', reason: 'request is ambiguous or may require implementation' };
}

export function selectTaskModel(prompt, currentModel, routing = {}, options = {}) {
  const baseModel = String(currentModel || '').trim();
  const enabled = routing && routing.enabled === true;
  const easyModel = String(routing && routing.easyModel || '').trim();
  const strongModel = String(routing && routing.strongModel || baseModel).trim() || baseModel;
  if (!enabled || !easyModel) {
    return {
      enabled: false,
      tier: 'strong',
      model: baseModel,
      strongModel,
      reason: enabled ? 'easy model is not configured' : 'automatic routing is disabled'
    };
  }
  const classification = classifyTask(prompt, options.hint);
  const requested = classification.tier === 'easy' ? easyModel : strongModel;
  return {
    enabled: true,
    tier: classification.tier,
    model: requested || baseModel,
    strongModel,
    reason: classification.reason
  };
}

export function sanitizeModelRouting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { enabled: false, easyModel: '', strongModel: '' };
  }
  const normalize = (item) => typeof item === 'string'
    ? item.trim().replace(/[\r\n\0]/g, '').slice(0, 200)
    : '';
  return {
    enabled: value.enabled === true,
    easyModel: normalize(value.easyModel),
    strongModel: normalize(value.strongModel)
  };
}
