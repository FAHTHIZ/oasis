import {
  classifyByRules,
  DEFAULT_ROUTING_CONFIG,
  inferToolRequirement
} from '@blockrun/router-core';
import { countTextTokens } from './tokens.mjs';

const SCORING = DEFAULT_ROUTING_CONFIG.scoring;
const MIN_CONFIDENCE = SCORING.confidenceThreshold;

const SAFETY_SIGNALS = [
  /\\b(?:security|authentication|authorization|permissions?|secrets?|credentials?|sandbox|threat model|prompt injection)\\b/i,
];

const HARD_SIGNALS = [
  /\\b(?:architect(?:ure)?|refactor|redesign|migration|migrate|upgrade|deployment|production|performance|concurrency|race condition|database|schema)\\b/i,
  /\\b(?:implement|build|create|add|remove|change|modify|rewrite|debug|fix|repair|test|tests|feature|workflow|integrat(?:e|ion))\\b/i,
  /\\b(?:multiple files|whole repository|entire repo|end.to.end|full product|across the project|everything about .{0,80}(?:repository|repo|codebase|project))\\b/i,
  /\\b(?:bug|defect|exception|stack trace|crash|failure)\\b/i,
  /\\b(?:and then|as well as|in addition|several|multiple)\\b/i
];

const EASY_SIGNALS = [
  /^(?:please\\s+)?(?:explain|summari[sz]e|describe|list|find|locate|show|identify|where|what|how does|how do)\\b/i,
  /\\b(?:read.only|quick overview|brief overview|what does .+ do|where is .+ defined)\\b/i
];

const MUTATION_SIGNALS = [
  /\\b(?:edit|write|change|modify|create|add|remove|delete|fix|repair|implement|build|refactor|rename|move|update|upgrade|migrate|install|commit|push|deploy)\\b/i,
  /\\b(?:make|turn|convert)\\s+.+\\s+(?:into|to)\\s+/i
];

const COMPLEX_DIMENSIONS = new Set([
  'codePresence',
  'reasoningMarkers',
  'multiStepPatterns',
  'questionComplexity'
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
 * The MIT-licensed router-core supplies a deterministic 15-dimension local
 * classifier. Oasis retains its own safety, mutation, tool-intent and
 * benchmark-hint overrides; only clearly simple, high-confidence,
 * non-actionable requests can use the configured cheaper model.
 */
export function classifyTask(prompt, hint = null) {
  const text = String(prompt || '').trim();
  const explicit = String(hint || '').toLowerCase();

  const safetySignal = SAFETY_SIGNALS.find((pattern) => pattern.test(text));
  if (safetySignal) return { tier: 'strong', reason: 'task contains a security-sensitive signal' };

  if (['large', 'medium', 'hard'].includes(explicit)) {
    return { tier: 'strong', reason: 'benchmark task is not marked small' };
  }
  if (['small', 'easy'].includes(explicit)) {
    return { tier: 'easy', reason: 'benchmark task marked small' };
  }
  if (!text) return { tier: 'strong', reason: 'empty task defaults to strong model' };

  const hardSignal = HARD_SIGNALS.find((pattern) => pattern.test(text));
  if (hardSignal) return { tier: 'strong', reason: 'task contains a change, complexity, or safety signal' };

  if (text.length > 1200 || text.split(/\\s+/).length > 180) {
    return { tier: 'strong', reason: 'long or detailed request defaults to strong model' };
  }

  const requiresAction = MUTATION_SIGNALS.some((pattern) => pattern.test(text))
    || inferToolRequirement(text);
  if (requiresAction) {
    return { tier: 'strong', reason: 'request appears to require an external tool or state change' };
  }

  const classification = classifyByRules(text, undefined, countTextTokens(text), SCORING);
  const complexSignals = hasComplexSignals(classification);
  const simplePattern = EASY_SIGNALS.some((pattern) => pattern.test(text)) && !complexSignals;
  const highConfidenceSimple = classification.tier === 'SIMPLE'
    && classification.confidence >= MIN_CONFIDENCE
    && !complexSignals
    && Number(classification.agenticScore || 0) < 0.6;

  if (simplePattern || highConfidenceSimple) {
    const detail = highConfidenceSimple
      ? '15-dimension classifier: SIMPLE (' + Math.round(classification.confidence * 100) + '% confidence)'
      : 'short, clearly read-only request';
    return { tier: 'easy', reason: detail };
  }

  const detail = classification.tier
    ? classification.tier + ' classification (' + Math.round(classification.confidence * 100) + '% confidence)'
    : 'ambiguous classification (' + Math.round(classification.confidence * 100) + '% confidence)';
  return {
    tier: 'strong',
    reason: '15-dimension classifier kept the request on the strong model: ' + detail
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
    ? item.trim().replace(/[\\r\\n\\0]/g, '').slice(0, 200)
    : '';
  return {
    enabled: value.enabled === true,
    easyModel: normalize(value.easyModel),
    strongModel: normalize(value.strongModel)
  };
}
