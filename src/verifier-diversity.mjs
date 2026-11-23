// Verifier diversity: how independent a review is of the work it reviewed.
//
// OASIS counts a review as independent when a separate session inspected the
// result (src/task-reviews.mjs). A separate session on the same model is a
// second sample from the same distribution: it tends to make the same mistake
// on the same input. Measured across hundreds of models, errors are strongly
// correlated, most of all within a provider and between the strongest models
// (Kim et al., "Correlated errors in large language models", ICML 2025); a
// panel of nine frontier judges from seven families carried the information
// of about two independent votes (Kohli, arXiv:2605.29800, 2026).
//
// This module gives every review a lineage relation to the models that did
// the work:
//
//   same-model        the reviewer is the author's model
//   same-lineage      same vendor or base family (claude-sonnet reviewing
//                     claude-opus, a qwen distill reviewing qwen)
//   different-lineage no shared vendor or base family
//   unknown           a model id it cannot place
//
// and from that a prior error correlation rho, the review's independence from
// the authors (1 - rho), and the panel's effective number of independent
// votes, Kish's n_eff = k / (1 + (k - 1) * mean rho). The priors are
// deliberately conservative readings of the papers above; they are not
// measured on this user's tasks.
//
// What it changes:
//   - task outcomes report `independent.diversity` (relations, independence,
//     effective votes), and a pass from the author's own model alone is
//     `verified`, not `independently_verified`: it is a second look, not an
//     independent one. Reviews that do not record a model are unchanged.
//   - modelRouting.reviewers = "diverse" (or OASIS_REVIEWER_ROUTING=diverse)
//     starts built-in reviewers and run_specialist_review on an allowed,
//     configured model of a different lineage from the author when there is
//     one, else a different model of the same lineage.

export const RHO = Object.freeze({ 'same-model': 0.9, 'same-lineage': 0.6, 'different-lineage': 0.4, unknown: 0.6 });

// Vendor or base family, matched against the model id with provider and
// routing prefixes removed. A distilled or fine-tuned model can match two
// (deepseek-r1-distill-qwen-32b is deepseek and qwen).
const LINEAGES = [
  ['anthropic', /\bclaude\b|\b(opus|sonnet|haiku|fable)\b/],
  ['openai', /\b(gpt|chatgpt|codex|davinci|o[1345])(\b|-)|\bgpt-?oss\b/],
  ['google', /\b(gemini|gemma|palm|bard)\b/],
  ['meta', /\b(llama|codellama)\b/],
  ['mistral', /\b(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)\b/],
  ['qwen', /\b(qwen|qwq)\w*/],
  ['deepseek', /\bdeepseek\b/],
  ['xai', /\bgrok\b/],
  ['moonshot', /\b(kimi|moonshot)\b/],
  ['zhipu', /\b(glm|chatglm)\b/],
  ['cohere', /\b(command|aya)\b/],
  ['microsoft', /\bphi-?\d/],
  ['nvidia', /\bnemotron\b/],
  ['minimax', /\bminimax\b/],
  ['ibm', /\bgranite\b/],
  ['ai2', /\b(olmo|tulu)\b/]
];

/** A comparable model id: lower case, no provider path, region or date tag. */
export function normalizeModel(id) {
  let text = String(id || '').trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^(models\/|[a-z]{2}\.)/, '');
  text = text.split('/').pop();
  text = text.replace(/^(anthropic|openai|google|vertex_ai|bedrock)\./, '');
  text = text.replace(/:(free|beta|latest|thinking|nitro|floor)$/, '');
  text = text.replace(/-v\d+:\d+$/, '');
  text = text.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return text;
}

/** { model, lineages } for a model id. lineages is empty when unknown. */
export function modelLineage(id) {
  const model = normalizeModel(id);
  const words = model.replace(/[_.:]/g, '-');
  const lineages = LINEAGES.filter(([, pattern]) => pattern.test(words)).map(([name]) => name);
  return { model, lineages };
}

/** The relation between two model ids. */
export function lineageRelation(a, b) {
  const left = modelLineage(a);
  const right = modelLineage(b);
  if (!left.model || !right.model) return 'unknown';
  if (left.model === right.model) return 'same-model';
  if (!left.lineages.length || !right.lineages.length) return 'unknown';
  return left.lineages.some((name) => right.lineages.includes(name)) ? 'same-lineage' : 'different-lineage';
}

/** Kish effective sample size of k votes with mean pairwise correlation rho. */
export function effectiveVotes(k, rho) {
  const n = Math.max(0, Math.floor(Number(k) || 0));
  if (n <= 1) return n;
  const r = Math.min(1, Math.max(0, Number(rho) || 0));
  return n / (1 + (n - 1) * r);
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * How independent a set of reviews is of the authors' models. `reviews` are
 * task-review entries ({ by, verdict, model }); `authors` model ids. Returns
 * null when no review records a model.
 */
export function reviewDiversity(reviews = [], authors = []) {
  const authorModels = [...new Set((authors || []).map((item) => String(item || '').trim()).filter(Boolean))];
  const known = (reviews || []).filter((review) => review && review.model);
  if (!known.length) return null;
  const items = known.map((review) => {
    const relations = authorModels.map((author) => lineageRelation(author, review.model));
    // The closest author decides: a review is only as independent as its
    // nearest relative among the models that did the work.
    const order = ['same-model', 'same-lineage', 'unknown', 'different-lineage'];
    const relation = relations.length ? order.find((name) => relations.includes(name)) : 'unknown';
    return { by: String(review.by || ''), model: String(review.model), verdict: review.verdict, relation, independence: round(1 - RHO[relation]) };
  });
  const passing = items.filter((item) => item.verdict === 'pass');
  // Mean pairwise rho among passing reviewers (their errors correlate with
  // each other, not only with the author).
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < passing.length; i += 1) for (let j = i + 1; j < passing.length; j += 1) { sum += RHO[lineageRelation(passing[i].model, passing[j].model)]; pairs += 1; }
  const panelRho = pairs ? sum / pairs : 0;
  const selfReview = Boolean(authorModels.length && passing.length && passing.every((item) => item.relation === 'same-model'));
  return {
    authors: authorModels,
    reviews: items,
    effectiveVotes: round(effectiveVotes(passing.length, panelRho)),
    independence: passing.length ? round(Math.max(...passing.map((item) => item.independence))) : 0,
    diverse: passing.some((item) => item.relation === 'different-lineage'),
    selfReview
  };
}

/**
 * The reviewer model for an author model from allowed candidates: a different
 * lineage first, then a different model of the same lineage. Ties keep the
 * candidates' order. Returns { model, relation } or null.
 */
export function pickReviewerModel(authorModel, candidates = []) {
  const seen = new Set();
  const ranked = [];
  for (const candidate of candidates) {
    const model = String(candidate || '').trim();
    if (!model || model.includes('*') || seen.has(model)) continue;
    seen.add(model);
    const relation = lineageRelation(authorModel, model);
    if (relation === 'same-model') continue;
    ranked.push({ model, relation, rank: relation === 'different-lineage' ? 0 : relation === 'same-lineage' ? 1 : 2 });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  // An unplaceable model is no evidence of independence; do not route to it.
  const best = ranked.find((item) => item.rank < 2);
  return best ? { model: best.model, relation: best.relation } : null;
}

/** True when reviewer routing is "diverse" for this session. */
export function diverseReviewersEnabled(settings, env = process.env) {
  const routing = (settings && settings.modelRouting) || {};
  return String(env.OASIS_REVIEWER_ROUTING || routing.reviewers || '').toLowerCase() === 'diverse';
}

/** The models a session could route a reviewer to, in preference order. */
export function reviewerCandidates(session) {
  const routing = (session && session.settings && session.settings.modelRouting) || {};
  return [
    ...(Array.isArray(routing.reviewerModels) ? routing.reviewerModels : []),
    routing.strongModel, routing.easyModel,
    ...Object.values(routing.routes || {}),
    ...(Array.isArray(routing.subagentModels) ? routing.subagentModels : []),
    ...((session && session.availableModels) || [])
  ].map((item) => String(item || '').trim()).filter(Boolean);
}

/** One line for a person: "2 reviews, 1.4 effective votes; code-review on gpt-5 (different lineage)". */
export function diversityNote(diversity) {
  if (!diversity) return '';
  const parts = diversity.reviews.map((item) => item.by + ' on ' + item.model + ' (' + item.relation.replace('-', ' ') + ')');
  return diversity.effectiveVotes + ' effective independent vote(s): ' + parts.join('; ') + (diversity.selfReview ? '. Every passing review ran on the author\'s own model.' : '');
}
