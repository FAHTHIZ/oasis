export const meta = {
  name: 'diagnose',
  description: 'Find the cause of a problem (a failing test, a bug, an outage, a drop in a metric) by competing hypotheses: several agents propose explanations blind, each hypothesis gets an agent that tries to refute it, every observation is rated against all hypotheses, and the posterior ranking, the decisive test and what would change the conclusion are reported',
  phases: ['Hypothesize', 'Frame', 'Falsify', 'Discriminate', 'Conclusion'],
}

// args: "problem description" [--agents 2-5]   or { problem, agents? }
const input = typeof args === 'string' ? { raw: args } : (args || {})
let problem = String(input.problem || input.raw || '').trim()
let width = Math.max(2, Math.min(5, Number(input.agents) || 3))
const flag = /(?:^|\s)--agents[= ](\d)\b/.exec(problem)
if (flag) { width = Math.max(2, Math.min(5, Number(flag[1]))); problem = problem.replace(flag[0], ' ').trim() }
if (!problem) return 'Usage: /diagnose <the problem: what happens, what was expected, where> [--agents 2-5]  (or args: { problem, agents })'

// Relative likelihoods for a rating of an observation against a hypothesis
// (Analysis of Competing Hypotheses, scored as a Bayesian update).
const L = { '++': 4, '+': 2, '0': 1, '-': 0.5, '--': 0.25 }
const OTHER_PRIOR = 0.1
const RULES = 'Observe, do not speculate: run the code, the test or the query, read the logs and files, fetch the pages. Every observation says how you got it (ran, read, fetched, or reasoned) and where (the command, file:line or URL). OASIS rejects reports that claim a check passed or cite a page without the tool results to show it.'
const ratingSchema = { type: 'array', items: { type: 'object', required: ['hypothesis', 'rating'], properties: { hypothesis: { type: 'string' }, rating: { type: 'string', enum: ['++', '+', '0', '-', '--'] } } } }
const observationSchema = { type: 'array', maxItems: 6, items: { type: 'object', required: ['what', 'how', 'ratings'], properties: { what: { type: 'string' }, how: { type: 'string', enum: ['ran', 'read', 'fetched', 'reasoned'] }, source: { type: 'string' }, ratings: ratingSchema } } }

// ---------------------------------------------------------- Hypothesize
// Blind: each agent proposes explanations without seeing the others, so the
// first plausible idea cannot anchor the rest.
phase('Hypothesize')
const LENSES = ['the most likely everyday causes', 'causes in the environment, configuration, data or dependencies rather than the code or process itself', 'recent changes and timing: what changed just before it started', 'rare or surprising causes an expert would still check', 'interactions between components, concurrency and ordering']
const proposals = await parallel(LENSES.slice(0, width).map((lens, index) => () => agent(
  `Problem to diagnose:\n"""\n${problem.slice(0, 8000)}\n"""\n\nPropose up to 4 distinct explanations of the cause, thinking especially about ${lens}. You may look around (read files, run quick read-only commands) to make them concrete, but do not try to prove one yet. For each: the hypothesis in one sentence, and a prediction: something that would be observed if it is the cause and would not be under the other likely explanations.`,
  { label: 'hypothesize ' + (index + 1), schema: { type: 'object', required: ['hypotheses'], properties: { hypotheses: { type: 'array', maxItems: 4, items: { type: 'object', required: ['hypothesis'], properties: { hypothesis: { type: 'string' }, prediction: { type: 'string' } } } } } } },
)))
const pool = proposals.filter(Boolean).flatMap((item) => item.hypotheses || []).filter((item) => String(item.hypothesis || '').trim())
log(`${pool.length} hypotheses proposed by ${proposals.filter(Boolean).length} agents working blind`)
if (pool.length < 2) return `# Diagnosis\n\nToo few hypotheses were proposed to compare (${pool.length}). Describe the problem in more detail: what happens, what was expected, and where.`

// ---------------------------------------------------------------- Frame
phase('Frame')
const framed = await agent(
  `Merge these proposed explanations of one problem into 2 to 6 mutually exclusive hypotheses. Combine duplicates, keep genuinely different ones apart, and keep a surprising one if it is plausible. For each, give the distinguishing prediction: what you would observe if it is true that the others do not predict.\n\nProblem:\n"""\n${problem.slice(0, 4000)}\n"""\n\nProposals:\n${pool.map((item, index) => `${index + 1}. ${item.hypothesis}${item.prediction ? ' (predicts: ' + item.prediction + ')' : ''}`).join('\n')}`,
  { label: 'frame hypotheses', schema: { type: 'object', required: ['hypotheses'], properties: { hypotheses: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'object', required: ['hypothesis', 'prediction'], properties: { hypothesis: { type: 'string' }, prediction: { type: 'string' } } } } } } },
)
const H = framed.hypotheses.slice(0, 6).map((item, index) => ({ id: 'H' + (index + 1), text: String(item.hypothesis).slice(0, 300), prediction: String(item.prediction || '').slice(0, 300) }))
const ids = new Set(H.map((h) => h.id))
const list = () => H.map((h) => `${h.id}: ${h.text}\n    predicts: ${h.prediction}`).join('\n')
const observations = []
const take = (items, by) => {
  for (const raw of Array.isArray(items) ? items : []) {
    const ratings = {}
    for (const entry of Array.isArray(raw.ratings) ? raw.ratings : []) if (ids.has(String(entry.hypothesis).trim()) && Object.hasOwn(L, entry.rating)) ratings[String(entry.hypothesis).trim()] = entry.rating
    if (!Object.keys(ratings).length || !String(raw.what || '').trim()) continue
    // Seen beats supposed: an observation the agent only reasoned to counts half.
    observations.push({ id: 'O' + (observations.length + 1), what: String(raw.what).slice(0, 400), how: raw.how, source: String(raw.source || '').slice(0, 200), ratings, by, weight: raw.how === 'reasoned' ? 0.5 : 1 })
  }
}
const score = () => {
  const log = Object.fromEntries(H.map((h) => [h.id, Math.log((1 - OTHER_PRIOR) / H.length)]))
  let other = Math.log(OTHER_PRIOR)
  const against = Object.fromEntries(H.map((h) => [h.id, 0]))
  const nonDiagnostic = []
  for (const item of observations) {
    const values = H.map((h) => L[item.ratings[h.id] || '0'])
    const all = values.every((value) => value < 1)
    if (Math.max(...values) === Math.min(...values) && !all) { nonDiagnostic.push(item.id); continue }
    H.forEach((h, index) => {
      log[h.id] += item.weight * Math.log(values[index])
      const rating = item.ratings[h.id] || '0'
      if (rating === '-' || rating === '--') against[h.id] += item.weight * (rating === '--' ? 2 : 1)
    })
    other += item.weight * (all ? 0 : values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
  }
  const top = Math.max(other, ...Object.values(log))
  const total = Math.exp(other - top) + Object.values(log).reduce((sum, value) => sum + Math.exp(value - top), 0)
  const ranked = H.map((h) => ({ ...h, posterior: Math.exp(log[h.id] - top) / total, against: against[h.id] })).sort((a, b) => b.posterior - a.posterior)
  return { ranked, other: Math.exp(other - top) / total, nonDiagnostic }
}

// Expected information gain (bits) of each candidate test over the current
// posterior; P(positive | hypothesis) from the predicted rating, 0.5 for
// "none of these".
const P = { '++': 0.95, '+': 0.75, '0': 0.5, '-': 0.25, '--': 0.05 }
const entropy = (ps) => -ps.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0)
const rankTests = (tests, current) => {
  const prior = [...H.map((h) => current.ranked.find((item) => item.id === h.id).posterior), current.other]
  const now = entropy(prior)
  return (Array.isArray(tests) ? tests : []).filter((item) => item && String(item.test || '').trim()).slice(0, 4).map((item) => {
    const predicted = {}
    for (const entry of Array.isArray(item.predictions) ? item.predictions : []) if (ids.has(String(entry.hypothesis).trim()) && Object.hasOwn(P, entry.rating)) predicted[String(entry.hypothesis).trim()] = entry.rating
    const likely = [...H.map((h) => P[predicted[h.id] || '0']), 0.5]
    const pos = prior.reduce((sum, p, i) => sum + p * likely[i], 0)
    const post = (yes) => { const joint = prior.map((p, i) => p * (yes ? likely[i] : 1 - likely[i])); const total = joint.reduce((a, b) => a + b, 0) || 1; return joint.map((value) => value / total) }
    return { test: String(item.test).slice(0, 300), bits: Math.max(0, now - (pos * entropy(post(true)) + (1 - pos) * entropy(post(false)))) }
  }).sort((a, b) => b.bits - a.bits)
}

// -------------------------------------------------------------- Falsify
// One agent per hypothesis, whose job is to refute it, rating everything it
// observes against all hypotheses. Disconfirming evidence is the informative
// kind: many observations fit several explanations.
phase('Falsify')
const tests = await pipeline(H, (h) => agent(
  `Diagnosing a problem with competing hypotheses. Your job: try to REFUTE ${h.id}. Look for what ${h.id} predicts and check whether it is actually so; a refutation that fails is evidence too.\n\nProblem:\n"""\n${problem.slice(0, 4000)}\n"""\n\nHypotheses:\n${list()}\n\nReport up to 6 observations. Rate each one against EVERY hypothesis: ++ strongly consistent, + consistent, 0 irrelevant, - inconsistent, -- rules it out. An observation that fits every hypothesis equally tells nothing; prefer ones that separate them. ${RULES}`,
  { label: 'falsify ' + h.id, schema: { type: 'object', required: ['observations', 'verdict'], properties: { observations: observationSchema, verdict: { type: 'string', enum: ['refuted', 'weakened', 'survived'] }, note: { type: 'string' } } } },
))
H.forEach((h, index) => { const result = tests[index]; if (result) { take(result.observations, 'falsifier of ' + h.id); h.verdict = result.verdict; h.note = String(result.note || '').slice(0, 300) } })
let state = score()
log(`${observations.length} observations; leader ${state.ranked[0].id} at ${Math.round(state.ranked[0].posterior * 100)}%` + (state.nonDiagnostic.length ? `; ${state.nonDiagnostic.length} non-diagnostic` : ''))

// --------------------------------------------------------- Discriminate
// When the two leaders are close, candidate tests are ranked by expected
// information and an agent runs the best one; when nothing listed survives,
// an agent looks for the missing explanation.
phase('Discriminate')
const [first, second] = state.ranked
let decisive = null
if (state.other > first.posterior) {
  const extra = await agent(
    `Every hypothesis below was contradicted by the evidence. Find the explanation that was missed.\n\nProblem:\n"""\n${problem.slice(0, 4000)}\n"""\n\nRuled out:\n${list()}\n\nEvidence so far:\n${observations.map((item) => `- ${item.id} (${item.how}${item.source ? ', ' + item.source : ''}): ${item.what}`).join('\n')}\n\nPropose the explanation that fits all of it, and check it. ${RULES}`,
    { label: 'find missing hypothesis', schema: { type: 'object', required: ['hypothesis', 'support'], properties: { hypothesis: { type: 'string' }, support: { type: 'string' }, how: { type: 'string', enum: ['ran', 'read', 'fetched', 'reasoned'] }, source: { type: 'string' } } } },
  )
  if (extra) decisive = { kind: 'missing', hypothesis: String(extra.hypothesis).slice(0, 300), support: String(extra.support || '').slice(0, 400), how: extra.how || 'reasoned', source: String(extra.source || '').slice(0, 200) }
} else if (first.posterior - second.posterior < 0.3) {
  // Bayesian experimental design: candidate tests are proposed with predicted
  // outcomes per hypothesis, and the one with the highest expected
  // information gain over the current posterior is the one that gets run.
  const candidates = await agent(
    `Two explanations of a problem remain close: ${first.id} and ${second.id}. Propose 2 to 4 different tests you could run or things you could look up, WITHOUT running them yet. For each, predict per hypothesis how likely the test comes out positive if that hypothesis is true: ++ almost surely, + likely, 0 either way, - unlikely, -- almost surely not.\n\nProblem:\n"""\n${problem.slice(0, 4000)}\n"""\n\nHypotheses:\n${list()}\n\nEvidence so far:\n${observations.map((item) => `- ${item.id}: ${item.what}`).join('\n')}`,
    { label: 'propose tests', schema: { type: 'object', required: ['tests'], properties: { tests: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['test', 'predictions'], properties: { test: { type: 'string' }, predictions: ratingSchema } } } } } },
  )
  const plan = rankTests(candidates && candidates.tests, state)
  if (plan.length) log('test plan: ' + plan.map((item) => `${item.test.slice(0, 60)} (${item.bits.toFixed(2)} bits)`).join('; '))
  const chosen = plan.length && plan[0].bits >= 0.05 ? plan[0] : null
  const result = await agent(
    (chosen ? `Two explanations of a problem remain close. Run this test, chosen because it is expected to separate the hypotheses most (${chosen.bits.toFixed(2)} bits): ${chosen.test}. Report what you observed.` : `Two explanations of a problem remain close. Design the single test whose result ${first.id} and ${second.id} predict differently, run it, and report what you observed.`) + `\n\nProblem:\n"""\n${problem.slice(0, 4000)}\n"""\n\nHypotheses:\n${list()}\n\nEvidence so far:\n${observations.map((item) => `- ${item.id}: ${item.what}`).join('\n')}\n\nRate what you observe against EVERY hypothesis (++ + 0 - --). ${RULES}`,
    { label: 'discriminate ' + first.id + ' vs ' + second.id, schema: { type: 'object', required: ['test', 'observations'], properties: { test: { type: 'string' }, observations: observationSchema } } },
  )
  if (result) { take(result.observations, 'discriminating test'); decisive = { kind: 'test', test: String(result.test || (chosen && chosen.test) || '').slice(0, 300), between: [first.id, second.id], ...(chosen ? { bits: chosen.bits, alternatives: plan.length - 1 } : {}) }; state = score() }
} else log(`${first.id} leads clearly; no discriminating test needed`)

// ----------------------------------------------------------- Conclusion
phase('Conclusion')
const winner = state.ranked[0]
const pct = (value) => Math.round(value * 100) + '%'
const direct = observations.filter((item) => item.weight === 1 && item.ratings[winner.id] && item.ratings[winner.id] !== '0')
const settled = winner.posterior >= 0.85 && direct.length >= 2 && new Set(direct.map((item) => item.by)).size >= 2
const lines = ['# Diagnosis', '']
if (decisive && decisive.kind === 'missing') lines.push(`None of the ${H.length} framed hypotheses survived (none of these: ${pct(state.other)}). The best remaining explanation, found afterwards and not yet scored: **${decisive.hypothesis}** (${decisive.how}${decisive.source ? ', ' + decisive.source : ''}): ${decisive.support}`)
else lines.push(`${settled ? 'Most likely cause' : 'Leading explanation (not settled)'}: **${winner.id}: ${winner.text}** at ${pct(winner.posterior)}.` + (settled ? '' : ' It lacks a clear margin or at least two direct observations from different agents; treat it as the next thing to verify, not as the answer.'))
lines.push('', '| Hypothesis | Posterior | Evidence against | Falsifier |', '| --- | --- | --- | --- |')
for (const h of state.ranked) lines.push(`| ${h.id}: ${h.text.replace(/\|/g, '/')} | ${pct(h.posterior)} | ${Math.round(h.against * 10) / 10} | ${h.verdict || '-'}${h.note ? ': ' + h.note.replace(/\|/g, '/').replace(/\s+/g, ' ') : ''} |`)
lines.push(`| none of these | ${pct(state.other)} | | |`)
lines.push('', '## Evidence', '', ...observations.map((item) => `- ${item.id} (${item.how}${item.source ? ', ' + item.source : ''}; ${item.by}${state.nonDiagnostic.includes(item.id) ? '; non-diagnostic, ignored' : ''}): ${item.what.replace(/\s+/g, ' ')} [${H.map((h) => h.id + ' ' + (item.ratings[h.id] || '0')).join(', ')}]`))
if (decisive && decisive.kind === 'test') lines.push('', '## Decisive test', '', `${decisive.between.join(' vs ')}: ${decisive.test}` + (decisive.bits !== undefined ? ` (chosen over ${decisive.alternatives} other candidate${decisive.alternatives === 1 ? '' : 's'} for the highest expected information, ${decisive.bits.toFixed(2)} bits)` : ''))
const runnerUp = state.ranked[1]
if (runnerUp) lines.push('', '## What would change this conclusion', '', `${runnerUp.id} (${pct(runnerUp.posterior)}) predicts: ${runnerUp.prediction}. Observing that would overturn the ranking.`)
lines.push('', `Method: ${proposals.filter(Boolean).length} agents proposed explanations without seeing each other's; they were merged into ${H.length} mutually exclusive hypotheses, each assigned an agent that tried to refute it. Every observation was rated against all hypotheses and scored as a Bayesian update (++ 4, + 2, 0 1, - 0.5, -- 0.25 relative likelihood; reasoned observations count half; observations that fit every hypothesis equally are ignored; "none of these" starts at 10% and rises when everything listed is contradicted).`)
return lines.join('\n')
