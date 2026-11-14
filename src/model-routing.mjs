import {
  classifyByRules,
  DEFAULT_ROUTING_CONFIG,
  inferToolRequirement
} from './task-classifier.mjs';
import { countTextTokens } from './tokens.mjs';
import { catalogImageInput, catalogToolCalling } from './model-catalog.mjs';

const SCORING = DEFAULT_ROUTING_CONFIG.scoring;
const MIN_CONFIDENCE = SCORING.confidenceThreshold;

const SAFETY_SIGNALS = [
  /\b(?:security|authentication|authorization|permissions?|secrets?|credentials?|sandbox|threat model|prompt injection)\b/i,
];

const HARD_SIGNALS = [
  /\b(?:architect(?:ure)?|refactor|redesign|migration|migrate|upgrade|deployment|production|performance|concurrency|race condition|database|schema)\b/i,
  /\b(?:implement|build|create|add|remove|change|modify|rewrite|debug|fix|repair|test|tests|feature|workflow|integrat(?:e|ion))\b/i,
  /\b(?:multiple files|whole repository|entire repo|end.to.end|full product|across the project|everything about .{0,80}(?:repository|repo|codebase|project))\b/i,
  /\b(?:bug|defect|exception|stack trace|crash|failure)\b/i,
  /\b(?:and then|as well as|in addition|several|multiple)\b/i
];

const EASY_SIGNALS = [
  /^(?:please\s+)?(?:define|explain|summari[sz]e|describe|list|find|locate|show|identify|where|what|how does|how do)\b/i,
  /\b(?:read.only|quick overview|brief overview|what does .+ do|where is .+ defined)\b/i
];

const MUTATION_SIGNALS = [
  /\b(?:edit|write|change|modify|create|add|remove|delete|fix|repair|implement|build|refactor|rename|move|update|upgrade|migrate|install|commit|push|deploy)\b/i,
  /\b(?:make|turn|convert)\s+.+\s+(?:into|to)\s+/i
];

const REPOSITORY_LOOKUP_SIGNALS = [
  /\b(?:find|locate|show|where is|where are|search for|look up|trace)\b.{0,120}\b(?:definition|declaration|implementation|call sites?|references?|usages?|symbol|function|class|method|variable)\b/i,
  /\b(?:definition|declaration|implementation|call sites?|references?|usages?)\b.{0,120}\b[A-Za-z_$][\w$]*[A-Z][\w$]*\b/i,
  /\b[A-Za-z_$][\w$]*[A-Z][\w$]*\s*\(/,
  /(?:^|[\s`"'(])(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|hpp|json|ya?ml|html|css)(?:$|[\s`"')\],])/i,
  /\b(?:in|inside|within|across)\s+(?:this|the|my|our)\s+(?:repo|repository|codebase|workspace|project)\b/i
];

const COMPLEX_DIMENSIONS = new Set([
  'codePresence',
  'reasoningMarkers',
  'multiStepPatterns',
]);

function hasComplexSignals(classification) {
  return (classification.dimensions || []).some((dimension) => {
    if (COMPLEX_DIMENSIONS.has(dimension.name)) return dimension.score > 0;
    return dimension.name === 'agenticTask' && dimension.score >= 0.6;
  });
}

/**
 * Conservative model routing.
 *
 * The local classifier supplies a deterministic task classification. Oasis
 * retains its own safety, mutation, tool-intent and benchmark-hint overrides;
 * only clearly simple, high-confidence, non-actionable requests can use the
 * configured cheaper model.
 */
export function classifyTask(prompt, hint = null) {
  const text = String(prompt || '').trim();
  const explicit = String(hint || '').toLowerCase();
  const requiresTools = MUTATION_SIGNALS.some((pattern) => pattern.test(text))
    || REPOSITORY_LOOKUP_SIGNALS.some((pattern) => pattern.test(text))
    || inferToolRequirement(text);

  const safetySignal = SAFETY_SIGNALS.find((pattern) => pattern.test(text));
  if (safetySignal) return { tier: 'strong', reason: 'task contains a security-sensitive signal', requiresTools, pinned: 'safety' };

  if (['large', 'medium', 'hard'].includes(explicit)) {
    return { tier: 'strong', reason: 'benchmark task is not marked small', requiresTools, pinned: 'hint' };
  }
  if (!text) return { tier: 'strong', reason: 'empty task defaults to strong model', requiresTools: false };

  const hardSignal = HARD_SIGNALS.find((pattern) => pattern.test(text));
  if (hardSignal) return { tier: 'strong', reason: 'task contains a change, complexity, or safety signal', requiresTools };

  if (text.length > 1200 || text.split(/\s+/).length > 180) {
    return { tier: 'strong', reason: 'long or detailed request defaults to strong model', requiresTools };
  }

  if (requiresTools) {
    return { tier: 'strong', reason: 'request requires tools, workspace access, or a state change', requiresTools: true };
  }

  // Hints are advisory: they cannot bypass the task's safety or action guards.
  if (['small', 'easy'].includes(explicit)) {
    return { tier: 'easy', reason: 'benchmark task marked small and passed read-only guards' };
  }

  const classification = classifyByRules(text, undefined, countTextTokens(text), SCORING);
  const complexSignals = hasComplexSignals(classification);
  const simplePattern = EASY_SIGNALS.some((pattern) => pattern.test(text)) && !complexSignals;
  const highConfidenceSimple = classification.tier === 'SIMPLE'
    && classification.confidence >= MIN_CONFIDENCE
    && !complexSignals
    && Number(classification.agenticScore || 0) < 0.6;

  if (simplePattern || highConfidenceSimple) {
    const detail = '15-dimension classifier: SIMPLE (' + Math.round(classification.confidence * 100) + '% confidence)';
    return { tier: 'easy', reason: detail, requiresTools: false };
  }

  const detail = classification.tier
    ? classification.tier + ' classification (' + Math.round(classification.confidence * 100) + '% confidence)'
    : 'ambiguous classification (' + Math.round(classification.confidence * 100) + '% confidence)';
  return {
    tier: 'strong',
    reason: '15-dimension classifier kept the request on the strong model: ' + detail,
    requiresTools: false
  };
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
  const requiresTools = classification.requiresTools === true;
  const requiresImages = options.requiresImages === true;
  let requested = classification.tier === 'easy' ? easyModel : strongModel;
  let tier = classification.tier;
  let reason = classification.reason;
  // Cascade: work that would go to the strong model starts on the cheaper one
  // and moves up only on evidence from the run (see src/escalation.mjs).
  // Security-sensitive and explicitly hard tasks still start strong.
  const cascade = routing.mode === 'cascade' && strongModel && strongModel !== easyModel;
  if (cascade && tier === 'strong' && !classification.pinned) {
    requested = easyModel;
    tier = 'work';
    reason = 'cascade: starts on ' + easyModel + ' and moves to ' + strongModel + ' if the run shows it is stuck (' + classification.reason + ')';
  }

  if (requested && (requiresTools || requiresImages)) {
    const catalogOptions = {
      baseURL: options.baseURL,
      provider: options.provider,
      env: options.env || process.env
    };
    const missingCapabilities = (model) => {
      const missing = [];
      // Explicit negative metadata blocks a candidate. Unknown stays eligible,
      // because aliases and self-hosted model IDs may be absent from the catalog.
      if (requiresTools && catalogToolCalling(model, catalogOptions) === false) missing.push('tool calling');
      if (requiresImages && catalogImageInput(model, catalogOptions) === false) missing.push('image input');
      return missing;
    };
    const candidates = [requested, strongModel, baseModel].filter((model, index, all) => model && all.indexOf(model) === index);
    const rejectedModel = requested;
    const rejected = missingCapabilities(rejectedModel);
    if (rejected.length) {
      const fallback = candidates.slice(1).find((model) => missingCapabilities(model).length === 0);
      if (fallback) {
        requested = fallback;
        tier = 'strong';
        const missingLabel = rejected.map((item) => item === 'tool calling' ? 'tool calls' : item).join(' and ');
        reason += '; selected ' + fallback + ' instead of ' + rejectedModel + ' because it is catalogued as not supporting ' + missingLabel;
      } else {
        requested = baseModel;
        tier = 'strong';
        reason += '; no configured candidate is catalogued for all required capabilities (' + rejected.join(' and ') + '); retained the configured model';
      }
    }
  }
  return {
    enabled: true,
    mode: cascade ? 'cascade' : 'classify',
    tier,
    model: requested || baseModel,
    strongModel,
    ...(tier === 'work' ? { escalateTo: strongModel } : {}),
    requiresTools,
    requiresImages,
    reason
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
    ...(value.mode === 'cascade' ? { mode: 'cascade' } : {}),
    easyModel: normalize(value.easyModel),
    strongModel: normalize(value.strongModel)
  };
}
