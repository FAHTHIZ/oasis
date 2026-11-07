/**
 * Local replacement for @blockrun/router-core.
 *
 * Provides the deterministic classification surface used by model-routing.mjs:
 * rule-based task classification, tool-requirement inference, and the default
 * routing scoring configuration.
 *
 * The classifier is intentionally conservative: ambiguous or potentially
 * action-oriented requests remain on the strong model.
 */

export const DEFAULT_ROUTING_CONFIG = Object.freeze({
  scoring: Object.freeze({
    confidenceThreshold: 0.72,
    weights: Object.freeze({
      codePresence: 0.18,
      reasoningMarkers: 0.16,
      multiStepPatterns: 0.18,
      questionComplexity: 0.14,
      agenticTask: 0.34
    })
  })
});

const CODE_SIGNALS = [
  /\b(?:function|class|method|variable|const|let|var|import|export|async|await|return|interface|type|struct|module|package)\b/i,
  /\b(?:\.js|\.mjs|\.cjs|\.ts|\.tsx|\.jsx|\.py|\.go|\.rs|\.java|\.kt|\.swift|\.rb|\.php|\.cs|\.cpp|\.c|\.h|\.hpp|\.json|\.ya?ml|\.html|\.css)\b/i,
  /\b(?:api|endpoint|database|schema|query|component|module|service|controller|test|bug|error|exception|stack trace)\b/i
];

const REASONING_SIGNALS = [
  /\b(?:why|how|explain|compare|evaluate|analyze|tradeoff|trade-off|design|architecture|reason|because|therefore)\b/i,
  /\b(?:should|would|could|might|recommend|consider|alternative|approach|strategy)\b/i
];

const MULTI_STEP_SIGNALS = [
  /\b(?:first|then|next|after that|finally|step\s*\d|steps|plan|workflow|pipeline|sequence)\b/i,
  /\b(?:and then|as well as|in addition|also|multiple|several)\b/i
];

const AGENTIC_SIGNALS = [
  /\b(?:implement|build|create|add|remove|delete|change|modify|update|upgrade|migrate|refactor|rename|move|fix|repair|debug|install|deploy|commit|push)\b/i,
  /\b(?:write|edit|generate|produce|run|execute|test|benchmark|optimize|automate)\b/i,
  /\b(?:whole|entire|full|complete)\s+(?:repository|repo|codebase|project|application|app)\b/i
];

const READ_ONLY_SIGNALS = [
  /^(?:please\s+)?(?:define|explain|summari[sz]e|describe|list|find|locate|show|identify|where|what|how does|how do)\b/i,
  /\b(?:read.only|quick overview|brief overview|what does .+ do|where is .+ defined)\b/i
];

const TOOL_SIGNALS = [
  /\b(?:edit|write|change|modify|create|add|remove|delete|fix|repair|implement|build|refactor|rename|move|update|upgrade|migrate|install|commit|push|deploy)\b/i,
  /\b(?:make|turn|convert)\s+.+\s+(?:into|to)\s+/i,
  /\bsearch the web\b/i,
  /\b(?:find|locate|show|where is|where are|search for|look up|trace)\b.{0,120}\b(?:definition|declaration|implementation|call sites?|references?|usages?|symbol|function|class|method|variable)\b/i,
  /\b(?:in|inside|within|across)\s+(?:this|the|my|our)\s+(?:repo|repository|codebase|workspace|project)\b/i
];

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function signalScore(text, patterns) {
  return patterns.some((pattern) => pattern.test(text)) ? 1 : 0;
}

function dimensions(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return [
    { name: 'codePresence', score: signalScore(text, CODE_SIGNALS) },
    { name: 'reasoningMarkers', score: signalScore(text, REASONING_SIGNALS) },
    { name: 'multiStepPatterns', score: signalScore(text, MULTI_STEP_SIGNALS) },
    { name: 'questionComplexity', score: clamp01(words / 120) },
    { name: 'agenticTask', score: signalScore(text, AGENTIC_SIGNALS) }
  ];
}

/**
 * Deterministic local task classification.
 *
 * Returns a conservative tier and confidence score. Requests with action,
 * code-change, multi-step, or high-complexity signals never classify as SIMPLE.
 */
export function classifyByRules(text, _unused, tokenCount, scoring = DEFAULT_ROUTING_CONFIG.scoring) {
  const value = String(text || '').trim();
  const dims = dimensions(value);
  const words = value.split(/\s+/).filter(Boolean).length;
  const effectiveTokens = Number.isFinite(Number(tokenCount)) ? Number(tokenCount) : words;

  const weights = scoring && scoring.weights ? scoring.weights : DEFAULT_ROUTING_CONFIG.scoring.weights;
  const weighted = dims.reduce((total, dimension) => {
    const weight = Number(weights[dimension.name] || 0);
    return total + dimension.score * weight;
  }, 0);

  const lengthPressure = clamp01(effectiveTokens / 180);
  const confidence = clamp01(0.45 + weighted * 0.45 + lengthPressure * 0.1);

  const isSimple =
    dims.every((dimension) => dimension.score === 0) &&
    effectiveTokens <= 120 &&
    READ_ONLY_SIGNALS.some((pattern) => pattern.test(value));

  return {
    tier: isSimple ? 'SIMPLE' : 'COMPLEX',
    confidence,
    dimensions: dims,
    agenticScore: dims.find((dimension) => dimension.name === 'agenticTask').score
  };
}

/**
 * Conservative tool-requirement inference.
 *
 * Returns true when a request likely needs workspace access, a state change,
 * or a tool-capable model.
 */
export function inferToolRequirement(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return TOOL_SIGNALS.some((pattern) => pattern.test(value));
}
