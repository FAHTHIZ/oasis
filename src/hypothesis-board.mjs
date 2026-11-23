// Competing hypotheses: a shared, evidence-scored hypothesis matrix for a
// team of agents.
//
// Research and debugging teams fail in a recognisable way: the first plausible
// explanation becomes the working theory, every agent gathers evidence that
// fits it, and evidence that fits every explanation equally is counted as
// support. Intelligence analysts call the remedy Analysis of Competing
// Hypotheses (Heuer, "Psychology of Intelligence Analysis", 1999, ch. 8):
// list every hypothesis, rate each piece of evidence against all of them, and
// judge by which hypothesis the evidence contradicts least, not which it
// "supports". Here that matrix is a shared runtime object that the main agent
// and every subagent read and write, scored as a Bayesian update:
//
//   - a question has 2 to 8 mutually exclusive hypotheses plus an implicit
//     "none of these" (10% prior), which no evidence can be rated against;
//     when every listed hypothesis is contradicted, it rises, telling the
//     team its hypothesis set is wrong
//   - evidence is rated against every hypothesis (++ + 0 - --), each rating a
//     relative likelihood; evidence rated the same for all hypotheses moves
//     nothing and is reported as non-diagnostic
//   - evidence is weighted by how much OASIS can trust it: halved when the
//     poster's own tool results do not back it (same grounding as the
//     knowledge board), halved again when it repeats a source already used on
//     this question (correlated evidence), and an agent's positive rating of
//     its own hypothesis counts half (self-confirmation)
//   - status gives each hypothesis's posterior and ACH inconsistency score,
//     and names the most informative next test: the two leading hypotheses
//     when they are close, and hypotheses nobody has tested yet
//   - a question settles itself as "leading" only with a clear posterior and
//     evidence from at least two independent sources and two agents
//
// The matrix lives on the session's knowledge board, so it is shared with
// every subagent and saved with the session.

import { siteOf } from './source-independence.mjs';
import { normalizeUrl } from './evidence-ledger.mjs';
import { basePriors } from './hypothesis-history.mjs';

const MAX_QUESTIONS = 20;
const MAX_HYPOTHESES = 8;
const MAX_EVIDENCE = 60;
const OTHER_PRIOR = 0.1;
const RATINGS = { '++': 4, '+': 2, '0': 1, '-': 0.5, '--': 0.25 };
const RATING_WORDS = { 'strongly-consistent': '++', consistent: '+', neutral: '0', inconsistent: '-', 'strongly-inconsistent': '--', supports: '+', refutes: '-', 'n/a': '0' };
const LEAD_POSTERIOR = 0.85;
const CLOSE_GAP = 0.25;
const Q_ID = /^q_[1-9]\d{0,4}$/;
const H_ID = /^h_[1-9]\d{0,4}$/;

export const HYPOTHESIS_TOOL_DEFINITION = { type: 'function', function: {
  name: 'hypotheses',
  description: 'Shared competing-hypotheses matrix for this session (Analysis of Competing Hypotheses, scored as a Bayesian update). Use it when the team must explain something (why a test fails, what caused an outage, which claim is true) and several explanations are possible. open a question with every plausible hypothesis; rate each piece of evidence against ALL of them, because evidence that fits every hypothesis proves nothing; status shows posteriors, which hypothesis the evidence contradicts least, and the most informative next test. Evidence your own tool results do not back, evidence that repeats a source already used, and support for your own hypothesis count less. Every agent of the session sees the same matrix.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['open', 'add', 'evidence', 'status', 'resolve'], description: 'open a question, add a hypothesis to one, post evidence, show status, or resolve a question' },
    question: { type: 'string', description: 'open: the question (max 300 characters). Other actions: its id, q_N' },
    hypotheses: { type: 'array', items: { type: 'string' }, description: 'open: 2-8 mutually exclusive hypotheses' },
    hypothesis: { type: 'string', description: 'add: the new hypothesis. resolve: the id (h_N) found true, or "none"' },
    evidence: { type: 'string', description: 'evidence: what was observed, one item per call (max 600 characters)' },
    sources: { type: 'array', items: { type: 'string' }, description: 'evidence: URLs you fetched or files/commands it comes from' },
    ratings: { type: 'object', additionalProperties: { type: 'string', enum: ['++', '+', '0', '-', '--'] }, description: 'evidence: rating per hypothesis id: ++ strongly consistent, + consistent, 0 neutral, - inconsistent, -- strongly inconsistent. Rate every hypothesis; unrated ones count as 0' },
    reason: { type: 'string', description: 'resolve: why' }
  }, required: ['action'] }
} };

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function emptyMatrix() {
  return { questions: [], nextQ: 1, nextH: 1, nextE: 1 };
}

/** A matrix restored from a saved session (or a fresh one). */
export function sanitizeMatrix(value) {
  const input = value && typeof value === 'object' ? value : {};
  const out = emptyMatrix();
  for (const raw of Array.isArray(input.questions) ? input.questions.slice(-MAX_QUESTIONS) : []) {
    if (!raw || !Q_ID.test(String(raw.id)) || !clean(raw.text, 300)) continue;
    const hypotheses = (Array.isArray(raw.hypotheses) ? raw.hypotheses : []).filter((h) => h && H_ID.test(String(h.id)) && clean(h.text, 300)).slice(0, MAX_HYPOTHESES)
      .map((h) => ({ id: h.id, text: clean(h.text, 300), by: clean(h.by, 100) || 'main', prior: Number.isFinite(h.prior) && h.prior > 0 ? Math.min(3, h.prior) : 1, ...(h.baseRate && typeof h.baseRate === 'object' ? { baseRate: { wins: Number(h.baseRate.wins) || 0, losses: Number(h.baseRate.losses) || 0, references: Number(h.baseRate.references) || 0 } } : {}) }));
    const ids = new Set(hypotheses.map((h) => h.id));
    const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).slice(-MAX_EVIDENCE).filter((e) => e && clean(e.text, 600)).map((e) => ({
      id: clean(e.id, 20), text: clean(e.text, 600), by: clean(e.by, 100) || 'main', grounded: e.grounded === true,
      sites: (Array.isArray(e.sites) ? e.sites : []).map((site) => clean(site, 200)).filter(Boolean).slice(0, 10),
      ratings: Object.fromEntries(Object.entries(e.ratings && typeof e.ratings === 'object' ? e.ratings : {}).filter(([id, rating]) => ids.has(id) && rating in RATINGS)),
      weight: Number.isFinite(e.weight) ? Math.min(1, Math.max(0, e.weight)) : 1,
      ...(e.untrusted ? { untrusted: true } : {}),
      ...(clean(e.model, 120) ? { model: clean(e.model, 120) } : {}),
      ...(clean(e.type, 80) ? { type: clean(e.type, 80) } : {})
    }));
    out.questions.push({ id: raw.id, text: clean(raw.text, 300), by: clean(raw.by, 100) || 'main', hypotheses, evidence, ...(raw.resolved && typeof raw.resolved === 'object' ? { resolved: { hypothesis: clean(raw.resolved.hypothesis, 20), by: clean(raw.resolved.by, 100), reason: clean(raw.resolved.reason, 400) } } : {}) });
  }
  const highest = (prefix, list) => list.reduce((max, id) => Math.max(max, Number(String(id).slice(prefix.length)) || 0), 0);
  out.nextQ = Math.max(Number(input.nextQ) || 1, highest('q_', out.questions.map((q) => q.id)) + 1);
  out.nextH = Math.max(Number(input.nextH) || 1, highest('h_', out.questions.flatMap((q) => q.hypotheses.map((h) => h.id))) + 1);
  out.nextE = Math.max(Number(input.nextE) || 1, highest('e_', out.questions.flatMap((q) => q.evidence.map((e) => e.id))) + 1);
  return out;
}

function matrixOf(board) {
  if (!board.hypotheses || !Array.isArray(board.hypotheses.questions)) board.hypotheses = emptyMatrix();
  return board.hypotheses;
}

function findQuestion(matrix, id) {
  const question = matrix.questions.find((item) => item.id === clean(id, 20));
  if (!question) throw new Error('Unknown question ' + clean(id, 20) + '. hypotheses status lists the open ones.');
  return question;
}

function normalizeRating(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (text in RATINGS) return text;
  if (text in RATING_WORDS) return RATING_WORDS[text];
  return null;
}

/**
 * Posterior per hypothesis (plus "none of these"), ACH inconsistency scores
 * and per-evidence diagnosticity. Pure: recomputed from the evidence.
 */
export function scoreQuestion(question) {
  const listed = question.hypotheses;
  const priorTotal = listed.reduce((sum, h) => sum + h.prior, 0) || 1;
  const log = new Map(listed.map((h) => [h.id, Math.log((1 - OTHER_PRIOR) * h.prior / priorTotal)]));
  let otherLog = Math.log(OTHER_PRIOR);
  const inconsistency = new Map(listed.map((h) => [h.id, 0]));
  const tested = new Set();
  const diagnostic = [];
  for (const item of question.evidence) {
    const values = listed.map((h) => RATINGS[item.ratings[h.id] || '0']);
    const contradictsAll = values.every((value) => value < 1);
    const spread = Math.max(...values) / Math.min(...values);
    // "None of these" is neutral relative to the set (the geometric mean of
    // the listed likelihoods), except when the evidence contradicts every
    // listed hypothesis: then it is the one explanation left standing.
    const otherL = contradictsAll ? 1 : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
    diagnostic.push({ id: item.id, diagnosticity: Math.round((contradictsAll ? 1 / Math.min(...values) : spread) * 100) / 100 });
    if (spread === 1 && !contradictsAll) continue;
    for (const [index, h] of listed.entries()) {
      const rating = item.ratings[h.id] || '0';
      if (rating !== '0') tested.add(h.id);
      const selfSupport = h.by === item.by && (rating === '+' || rating === '++') ? 0.5 : 1;
      log.set(h.id, log.get(h.id) + item.weight * selfSupport * Math.log(values[index]));
      if (rating === '-' || rating === '--') inconsistency.set(h.id, inconsistency.get(h.id) + item.weight * (rating === '--' ? 2 : 1));
    }
    otherLog += item.weight * Math.log(otherL);
  }
  const all = [...log.values(), otherLog];
  const top = Math.max(...all);
  const total = all.reduce((sum, value) => sum + Math.exp(value - top), 0);
  const posterior = new Map(listed.map((h) => [h.id, Math.exp(log.get(h.id) - top) / total]));
  return { posterior, other: Math.exp(otherLog - top) / total, inconsistency, tested, diagnostic };
}

export function questionView(question) {
  const score = scoreQuestion(question);
  const round = (value) => Math.round(value * 1000) / 1000;
  const hypotheses = question.hypotheses.map((h) => ({ id: h.id, text: h.text, by: h.by, posterior: round(score.posterior.get(h.id)), inconsistency: Math.round(score.inconsistency.get(h.id) * 100) / 100, tested: score.tested.has(h.id), ...(h.baseRate ? { base_rate: 'prior x' + h.prior + ': similar explanations were the answer in ' + h.baseRate.wins + ' and ruled out in ' + h.baseRate.losses + ' (similarity-weighted) of ' + h.baseRate.references + ' similar past question' + (h.baseRate.references === 1 ? '' : 's') } : {}) }))
    .sort((a, b) => b.posterior - a.posterior);
  const [first, second] = hypotheses;
  const diagnosticEvidence = question.evidence.filter((item, index) => score.diagnostic[index].diagnosticity > 1);
  const sites = new Set(diagnosticEvidence.flatMap((item) => item.sites));
  const agents = new Set(diagnosticEvidence.map((item) => item.by));
  const independentSupport = sites.size + diagnosticEvidence.filter((item) => !item.sites.length && item.grounded).length;
  const advice = [];
  if (score.other > Math.max(0.3, first ? first.posterior : 0)) advice.push('"None of these" now leads (' + round(score.other) + '): the evidence contradicts every listed hypothesis. Add the hypothesis you are missing (action add).');
  const untested = hypotheses.filter((h) => !h.tested);
  if (untested.length) advice.push('Untested: ' + untested.map((h) => h.id).join(', ') + '. Look for evidence that would contradict them; disconfirming evidence is the most informative.');
  if (first && second && first.posterior - second.posterior < CLOSE_GAP) advice.push('Most informative next test: something ' + first.id + ' and ' + second.id + ' predict differently ("' + first.text.slice(0, 80) + '" vs "' + second.text.slice(0, 80) + '"). Evidence that fits both moves nothing.');
  const nonDiagnostic = score.diagnostic.filter((item) => item.diagnosticity === 1).map((item) => item.id);
  if (nonDiagnostic.length) advice.push('Non-diagnostic (rated the same for every hypothesis, ignored): ' + nonDiagnostic.join(', ') + '.');
  let state = 'open';
  if (question.resolved) state = 'resolved';
  else if (first && first.posterior >= LEAD_POSTERIOR && independentSupport >= 2 && agents.size >= 2) state = 'leading';
  else if (first && first.posterior >= LEAD_POSTERIOR) advice.push(first.id + ' leads, but on ' + (agents.size < 2 ? 'one agent\'s evidence' : 'fewer than two independent sources') + '; get an independent check before treating it as settled.');
  return {
    id: question.id, question: question.text, state,
    ...(state === 'leading' ? { leading: first.id } : {}),
    ...(question.resolved ? { resolved: question.resolved } : {}),
    hypotheses, none_of_these: round(score.other),
    evidence: question.evidence.map((item, index) => ({ id: item.id, text: item.text.slice(0, 200), by: item.by, ratings: item.ratings, weight: item.weight, diagnosticity: score.diagnostic[index].diagnosticity, ...(item.untrusted ? { untrusted: true } : {}) })),
    ...(advice.length ? { advice } : {})
  };
}

/**
 * Run the hypotheses tool. ground(text, sources) -> { issues, grounds } is the
 * knowledge board's grounding against the acting agent's own tool results.
 */
export function runHypothesisTool(session, board, args = {}, { actor = 'main', ground = () => ({ issues: [], grounds: [] }), untrusted = false, model = '', type = '', ledger = null, history = null } = {}) {
  const matrix = matrixOf(board);
  const action = String(args.action || 'status');
  if (action === 'open') {
    const text = clean(args.question, 300);
    if (!text) throw new Error('open needs the question.');
    const list = [...new Set((Array.isArray(args.hypotheses) ? args.hypotheses : []).map((item) => clean(item, 300)).filter(Boolean))];
    if (list.length < 2) throw new Error('open needs at least two competing hypotheses; a single explanation is not a comparison.');
    if (list.length > MAX_HYPOTHESES) throw new Error('At most ' + MAX_HYPOTHESES + ' hypotheses per question.');
    if (matrix.questions.filter((q) => !q.resolved).length >= MAX_QUESTIONS) throw new Error('Too many open questions; resolve some first.');
    // The outside view: similar questions resolved before set the priors (src/hypothesis-history.mjs).
    let rates = [];
    try { rates = history ? basePriors(text, list, history.cases()) : []; } catch { rates = []; }
    const question = { id: 'q_' + matrix.nextQ++, text, by: actor, hypotheses: list.map((item, index) => {
      const rate = rates[index];
      return { id: 'h_' + matrix.nextH++, text: item, by: actor, prior: rate ? rate.prior : 1, ...(rate && (rate.wins || rate.losses) ? { baseRate: { wins: rate.wins, losses: rate.losses, references: rate.references } } : {}) };
    }), evidence: [] };
    matrix.questions.push(question);
    if (matrix.questions.length > MAX_QUESTIONS) matrix.questions.splice(matrix.questions.findIndex((q) => q.resolved) >= 0 ? matrix.questions.findIndex((q) => q.resolved) : 0, 1);
    return { opened: question.id, ...questionView(question), note: 'Rate every piece of evidence against all hypotheses (action evidence, ratings {"' + question.hypotheses[0].id + '": "+", "' + question.hypotheses[1].id + '": "--", ...}). Other agents of this session see this question.' };
  }
  if (action === 'add') {
    const question = findQuestion(matrix, args.question);
    if (question.resolved) throw new Error(question.id + ' is resolved.');
    const text = clean(args.hypothesis, 300);
    if (!text) throw new Error('add needs the hypothesis text.');
    if (question.hypotheses.length >= MAX_HYPOTHESES) throw new Error('At most ' + MAX_HYPOTHESES + ' hypotheses per question.');
    const hypothesis = { id: 'h_' + matrix.nextH++, text, by: actor, prior: 1 };
    question.hypotheses.push(hypothesis);
    return { added: hypothesis.id, ...questionView(question), note: 'Earlier evidence counts as neutral for ' + hypothesis.id + ' until someone rates it; re-post the evidence that bears on it.' };
  }
  if (action === 'evidence') {
    const question = findQuestion(matrix, args.question);
    if (question.resolved) throw new Error(question.id + ' is resolved.');
    const text = clean(args.evidence, 600);
    if (!text) throw new Error('evidence needs the observation.');
    const ids = new Set(question.hypotheses.map((h) => h.id));
    const ratings = {};
    for (const [id, value] of Object.entries(args.ratings && typeof args.ratings === 'object' ? args.ratings : {})) {
      if (!ids.has(id)) throw new Error('Unknown hypothesis ' + id + ' for ' + question.id + '.');
      const rating = normalizeRating(value);
      if (!rating) throw new Error('Rating for ' + id + ' must be one of ++ + 0 - --.');
      ratings[id] = rating;
    }
    if (!Object.keys(ratings).length) throw new Error('Rate the evidence against the hypotheses (ratings).');
    const sources = (Array.isArray(args.sources) ? args.sources : []).map((item) => clean(item, 500)).filter(Boolean).slice(0, 10);
    const { issues, grounds } = ground(text, sources);
    if (issues.length) throw new Error('Not posted: ' + issues.map((issue) => issue.reason.replace(/^the report/, 'the evidence')).join('; ') + '. Fetch the page or run the check first.');
    const sites = [...new Set(sources.map((item) => normalizeUrl(item)).filter(Boolean).map(siteOf).filter(Boolean))];
    const used = new Set(question.evidence.flatMap((item) => item.sites));
    const repeats = sites.length > 0 && sites.every((site) => used.has(site));
    let weight = 1;
    const why = [];
    if (!grounds.length) { weight *= 0.5; why.push('not backed by your own tool results'); }
    if (repeats) { weight *= 0.5; why.push('repeats a source already used on this question (' + sites.join(', ') + ')'); }
    if (untrusted) { weight *= 0.5; why.push('you read content that looked like a prompt injection'); }
    const item = { id: 'e_' + matrix.nextE++, text, by: actor, grounded: grounds.length > 0, sites, ratings, weight, ...(untrusted ? { untrusted: true } : {}), ...(clean(model, 120) ? { model: clean(model, 120) } : {}), ...(clean(type, 80) ? { type: clean(type, 80) } : {}) };
    question.evidence.push(item);
    if (question.evidence.length > MAX_EVIDENCE) question.evidence.shift();
    const unrated = question.hypotheses.filter((h) => !(h.id in ratings)).map((h) => h.id);
    const view = questionView(question);
    return {
      posted: item.id, weight, ...(why.length ? { weight_reason: why.join('; ') } : {}),
      ...(unrated.length ? { unrated, note_on_ratings: 'Counted as neutral for ' + unrated.join(', ') + '. Evidence matters by how it separates hypotheses; rate it against each.' } : {}),
      ...view
    };
  }
  if (action === 'resolve') {
    const question = findQuestion(matrix, args.question);
    const choice = clean(args.hypothesis, 20);
    if (choice !== 'none' && !question.hypotheses.some((h) => h.id === choice)) throw new Error('resolve needs the hypothesis id that was found true, or "none".');
    const view = questionView(question);
    const top = view.hypotheses[0];
    question.resolved = { hypothesis: choice, by: actor, reason: clean(args.reason, 400) };
    // Only the coordinator's resolution scores the raters, so no agent grades its own evidence.
    const scored = actor === 'main' ? scoreRaters(question, choice, ledger, board.uid || 'board') : 0;
    if (actor === 'main' && history && typeof history.record === 'function') {
      try { history.record({ id: (board.uid || 'board') + ':' + question.id, question: question.text, answer: choice === 'none' ? '' : question.hypotheses.find((h) => h.id === choice).text, rejected: question.hypotheses.filter((h) => h.id !== choice).map((h) => h.text) }); } catch {}
    }
    return { ...questionView(question), ...(scored ? { calibration: scored + ' evidence rating' + (scored === 1 ? '' : 's') + ' scored against the answer (oasis agents calibration)' } : {}), ...(top && choice !== top.id ? { warning: 'Resolved against the evidence: ' + top.id + ' had the highest posterior (' + top.posterior + '). Say why in your report.' } : {}) };
  }
  if (action === 'status') {
    if (args.question) return questionView(findQuestion(matrix, args.question));
    const questions = matrix.questions.map(questionView);
    return { questions, open: questions.filter((q) => q.state === 'open').length, note: questions.length ? 'Posteriors are recomputed from the evidence each time; inconsistency counts how much evidence contradicts each hypothesis (lower is better, as in ACH).' : 'No questions yet. Open one with action open when several explanations are possible.' };
  }
  throw new Error('Unknown hypotheses action ' + action + '.');
}

/**
 * Each piece of evidence is an implicit forecast: its ratings, as normalised
 * likelihoods, put the most probability on one hypothesis. When the question
 * is resolved, that forecast held if it pointed at the answer. Recorded per
 * model in the calibration ledger (kind "hypothesis"), so an agent whose
 * evidence keeps pointing the wrong way shows up in its calibration record.
 */
export function raterForecasts(question, answer) {
  const out = [];
  for (const item of question.evidence) {
    const values = question.hypotheses.map((h) => RATINGS[item.ratings[h.id] || '0']);
    const top = Math.max(...values);
    if (top === Math.min(...values) || values.filter((value) => value === top).length > 1) continue;
    const favoured = question.hypotheses[values.indexOf(top)].id;
    const p = Math.round(top / values.reduce((sum, value) => sum + value, 0) * 1000) / 1000;
    out.push({ evidence: item.id, by: item.by, model: item.model || 'unknown', type: item.type || '', favoured, p, o: favoured === answer ? 1 : 0 });
  }
  return out;
}

function scoreRaters(question, answer, ledger, uid) {
  if (!ledger || typeof ledger.record !== 'function') return 0;
  let count = 0;
  for (const forecast of raterForecasts(question, answer)) {
    try { if (ledger.record({ id: uid + ':' + question.id + ':' + forecast.evidence, model: forecast.model, type: forecast.type, p: forecast.p, o: forecast.o, kind: 'hypothesis' })) count++; } catch {}
  }
  return count;
}

/** One line per open question for a starting subagent, '' when none. */
export function hypothesisPromptLines(board, limit = 3) {
  const matrix = board && board.hypotheses;
  if (!matrix || !Array.isArray(matrix.questions)) return '';
  const open = matrix.questions.filter((q) => !q.resolved).slice(-limit);
  if (!open.length) return '';
  return 'Open questions on the hypotheses matrix (rate evidence you find against them with the hypotheses tool):\n' + open.map((question) => {
    const view = questionView(question);
    return '- ' + question.id + ' ' + question.text.slice(0, 120) + ': ' + view.hypotheses.slice(0, 4).map((h) => h.id + ' ' + h.text.slice(0, 60) + ' (' + h.posterior + ')').join('; ');
  }).join('\n');
}
