export const meta = {
  name: 'debate',
  description: 'Structured debate: advocates argue assigned positions with fetched, quoted evidence over rounds of typed moves (challenge, concede, counter, withdraw); disputed arguments are fact-checked independently; a judge rules on the argument ledger and reports consensus, dissent and cruxes',
  phases: ['Frame', 'Opening', 'Rebuttal', 'Fact-check', 'Judgement'],
}

// args: "question" or { question, positions?: [string | {name, thesis}], rounds?: 1-3 }
const input = typeof args === 'string' ? { question: args } : (args || {})
let question = String(input.question || input.prompt || '').trim()
let rounds = Math.max(1, Math.min(3, Number(input.rounds) || 2))
const roundsFlag = /\s--rounds[= ](\d)\b/.exec(question)
if (roundsFlag) { rounds = Math.max(1, Math.min(3, Number(roundsFlag[1]))); question = question.replace(roundsFlag[0], '').trim() }
if (!question) return 'Usage: /debate <question> [--rounds 1-3]  (or args: { question, positions: [...], rounds })'

const EVIDENCE_RULES = 'Evidence rules (OASIS enforces them and rejects reports that break them): cite only pages you fetched with fetch_url in this run; put a short verbatim quote from the page next to each cited claim and check it with verify_quote first; two pages that copy the same story are one source (source_independence).'
const argumentSchema = { type: 'object', required: ['claim'], properties: { claim: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string' } } }

// ---------------------------------------------------------------- Frame
phase('Frame')
let positions = Array.isArray(input.positions) ? input.positions.map((item, index) => (typeof item === 'string' ? { name: 'P' + (index + 1), thesis: item } : { name: String(item.name || 'P' + (index + 1)), thesis: String(item.thesis || item.position || '') })).filter((item) => item.thesis) : []
let cruxes = []
if (positions.length < 2) {
  const frame = await agent(
    `Frame a structured debate on this question: ${question}\n\nIdentify 2 to 4 genuinely distinct answers that a well-informed person could defend (the strongest form of each, never a straw man; include "it depends" only if it is a real, specific position). Give each a short name and a one-sentence thesis. Then list the cruxes: the specific factual or value questions on which the positions disagree, and for each, what evidence would settle it. You may search the web to understand the question; do not argue yet.`,
    { label: 'frame positions', schema: { type: 'object', required: ['positions'], properties: { positions: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['name', 'thesis'], properties: { name: { type: 'string' }, thesis: { type: 'string' } } } }, cruxes: { type: 'array', maxItems: 6, items: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, settled_by: { type: 'string' } } } } } } },
  )
  positions = frame.positions.slice(0, 4)
  cruxes = frame.cruxes || []
}
positions = positions.map((item, index) => ({ id: 'P' + (index + 1), name: item.name, thesis: item.thesis, confidence: [] }))
log(`${positions.length} positions: ${positions.map((item) => item.id + ' ' + item.name).join('; ')}`)

// The argument ledger: every claim made, who made it, and what happened to it.
const ledger = []
const addArgument = (position, item, round, target) => {
  const id = position.id + '.' + (ledger.filter((entry) => entry.position === position.id).length + 1)
  ledger.push({ id, position: position.id, round, claim: String(item.claim || '').slice(0, 600), url: String(item.url || '').trim(), quote: String(item.quote || '').trim().slice(0, 400), status: 'standing', challenges: [], concededBy: [], ...(target ? { counters: target } : {}) })
  return id
}
const brief = (entry) => `${entry.id} [${entry.status}${entry.concededBy.length ? ', conceded by ' + entry.concededBy.join(' ') : ''}${entry.challenges.length ? ', challenged ' + entry.challenges.length + 'x' : ''}] ${entry.claim}${entry.url ? ' (' + entry.url + (entry.quote ? ': "' + entry.quote + '"' : '') + ')' : ' (no source)'}`

// -------------------------------------------------------------- Opening
phase('Opening')
const openings = await parallel(positions.map((position) => () => agent(
  `You are the advocate for one position in a structured debate.\nQuestion: ${question}\nYour position (${position.id}, "${position.name}"): ${position.thesis}\nOther positions: ${positions.filter((other) => other !== position).map((other) => other.id + ' "' + other.name + '": ' + other.thesis).join(' | ')}\n\nResearch with web_search and fetch_url and build the strongest honest case: up to 5 arguments, each one specific, checkable claim with the URL of a page you fetched and a verbatim quote from it (a pure reasoning step may have no url). Prefer primary sources. ${EVIDENCE_RULES}\nThen give your honest probability (0 to 1) that your position is correct, and the single strongest point against it.`,
  { label: 'open ' + position.id, schema: { type: 'object', required: ['arguments', 'confidence'], properties: { arguments: { type: 'array', minItems: 1, maxItems: 5, items: argumentSchema }, confidence: { type: 'number', minimum: 0, maximum: 1 }, weakest_point: { type: 'string' } } } },
)))
positions.forEach((position, index) => {
  const opening = openings[index]
  if (!opening) { position.forfeit = true; return }
  for (const item of opening.arguments) addArgument(position, item, 0)
  position.confidence.push(opening.confidence)
  position.weakest = opening.weakest_point || ''
})
const active = () => positions.filter((position) => !position.forfeit)
log(`${ledger.length} opening arguments` + (active().length < positions.length ? `; ${positions.length - active().length} advocate(s) failed and forfeit` : ''))
if (active().length < 2) return `The debate could not run: ${active().length} of ${positions.length} advocates produced an opening that passed OASIS's evidence checks.`

// ------------------------------------------------------------- Rebuttal
phase('Rebuttal')
for (let round = 1; round <= rounds; round += 1) {
  const replies = await parallel(active().map((position) => () => agent(
    `Round ${round} of ${rounds} of a structured debate. You advocate ${position.id} ("${position.name}"): ${position.thesis}\nQuestion: ${question}\n\nThe argument ledger so far:\n${ledger.filter((entry) => entry.status !== 'withdrawn').map(brief).join('\n')}\n\nRespond with moves, each targeting a ledger id:\n- challenge: an opponent's argument is wrong, unsupported, misread or irrelevant; give your reason and, where it is factual, a fetched url and verbatim quote\n- concede: an opponent's argument is correct (be honest; conceding true points is scored as credibility, not weakness)\n- counter: a new argument that answers a specific one (url and quote as for any argument)\n- withdraw: one of your own arguments that you now think is wrong\nRespond to the strongest opposing arguments, not the weakest. ${EVIDENCE_RULES}\nThen give your updated probability (0 to 1) that your position is correct, and what evidence would change your mind.`,
    { label: `round ${round} ${position.id}`, schema: { type: 'object', required: ['moves', 'confidence'], properties: { moves: { type: 'array', maxItems: 6, items: { type: 'object', required: ['act', 'target'], properties: { act: { type: 'string', enum: ['challenge', 'concede', 'counter', 'withdraw'] }, target: { type: 'string' }, reason: { type: 'string' }, claim: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string' } } } }, confidence: { type: 'number', minimum: 0, maximum: 1 }, would_change_mind: { type: 'string' } } } },
  )))
  let applied = 0
  active().forEach((position, index) => {
    const reply = replies[index]
    if (!reply) return
    position.confidence.push(reply.confidence)
    if (reply.would_change_mind) position.wouldChange = reply.would_change_mind
    for (const move of reply.moves) {
      const target = ledger.find((entry) => entry.id === String(move.target || '').trim())
      if (!target) continue
      const own = target.position === position.id
      if (move.act === 'withdraw' && own) { target.status = 'withdrawn'; applied += 1 }
      else if (move.act === 'concede' && !own && !target.concededBy.includes(position.id)) { target.concededBy.push(position.id); applied += 1 }
      else if (move.act === 'challenge' && !own) { target.challenges.push({ by: position.id, round, reason: String(move.reason || move.claim || '').slice(0, 500), url: String(move.url || ''), quote: String(move.quote || '').slice(0, 400) }); applied += 1 }
      else if (move.act === 'counter' && !own && move.claim) { addArgument(position, move, round, target.id); target.challenges.push({ by: position.id, round, reason: 'countered by ' + ledger[ledger.length - 1].id, url: String(move.url || ''), quote: '' }); applied += 1 }
    }
  })
  log(`round ${round}: ${applied} moves applied`)
}

// ----------------------------------------------------------- Fact-check
// Every argument that is still disputed (challenged, not conceded by its
// challengers) gets an independent fact-checker that saw none of the debate.
phase('Fact-check')
const disputed = ledger.filter((entry) => entry.status === 'standing' && entry.challenges.length && entry.challenges.some((challenge) => !entry.concededBy.includes(challenge.by))).slice(0, 12)
const verdicts = await pipeline(disputed, (entry) => agent(
  `Fact-check one disputed claim from a debate, independently. You did not take part, and you have no side.\nClaim: ${entry.claim}\nCited: ${entry.url || '(no source)'}${entry.quote ? '\nQuoted as: "' + entry.quote + '"' : ''}\nObjections raised:\n${entry.challenges.map((challenge) => '- ' + challenge.reason + (challenge.url ? ' (' + challenge.url + (challenge.quote ? ': "' + challenge.quote + '"' : '') + ')' : '')).join('\n')}\n\nFetch the cited page and the objectors' sources, and search for an independent source. verdict "supported" if reliable sources you read state the claim, "refuted" if they contradict it, "unsettled" if the evidence is mixed or missing. Note what you found in one or two sentences. ${EVIDENCE_RULES}`,
  { label: 'check ' + entry.id, schema: { type: 'object', required: ['verdict', 'note'], properties: { verdict: { type: 'string', enum: ['supported', 'refuted', 'unsettled'] }, note: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string' }, independent_sources: { type: 'integer', minimum: 0 } } } },
))
disputed.forEach((entry, index) => {
  const verdict = verdicts[index]
  entry.status = verdict ? verdict.verdict : 'unsettled'
  if (verdict) entry.check = { note: verdict.note, url: verdict.url || '', quote: verdict.quote || '', independent: verdict.independent_sources || 0 }
})
for (const entry of ledger) {
  if (entry.status !== 'standing') continue
  entry.status = entry.concededBy.length ? 'conceded' : entry.challenges.length ? 'standing' : 'unchallenged'
}
log(`fact-checked ${disputed.length}: ${disputed.filter((entry) => entry.status === 'supported').length} supported, ${disputed.filter((entry) => entry.status === 'refuted').length} refuted, ${disputed.filter((entry) => entry.status === 'unsettled').length} unsettled`)

// The evidence tally is computed, not judged: what survived scrutiny.
const POINTS = { supported: 3, conceded: 3, unchallenged: 1, standing: 1, unsettled: 0.5, refuted: -2, withdrawn: 0 }
for (const position of positions) {
  const own = ledger.filter((entry) => entry.position === position.id)
  position.score = own.reduce((sum, entry) => sum + (POINTS[entry.status] ?? 0) * (entry.url || entry.status === 'conceded' ? 1 : 0.5), 0)
  position.counts = {}
  for (const entry of own) position.counts[entry.status] = (position.counts[entry.status] || 0) + 1
  position.concessionsMade = ledger.filter((entry) => entry.concededBy.includes(position.id)).length
}
const ranked = [...active()].sort((a, b) => b.score - a.score)

// ------------------------------------------------------------ Judgement
phase('Judgement')
const record = {
  question,
  positions: positions.map((position) => ({ id: position.id, name: position.name, thesis: position.thesis, evidence_score: position.score, argument_outcomes: position.counts, concessions_made: position.concessionsMade, confidence_open_to_close: position.confidence, ...(position.wouldChange ? { would_change_mind: position.wouldChange } : {}), ...(position.forfeit ? { forfeit: true } : {}) })),
  ledger: ledger.map((entry) => ({ id: entry.id, position: entry.position, claim: entry.claim, url: entry.url, quote: entry.quote, status: entry.status, conceded_by: entry.concededBy, objections: entry.challenges.map((challenge) => challenge.by + ': ' + challenge.reason), ...(entry.check ? { fact_check: entry.check.note } : {}) })),
  cruxes,
}
const judgement = await agent(
  `You are the judge of a structured debate. Rule only on the record below; do not use tools and add no facts of your own.\n\nRubric, in order: (1) which claims survived scrutiny (fact-check verdicts, concessions by opponents) and how much they bear on the question; (2) evidence quality (primary, independent, quoted sources over unsourced reasoning); (3) responsiveness (did each side answer the strongest opposing arguments); (4) calibration (did confidence move sensibly with the evidence). The evidence_score is a mechanical tally of argument outcomes; you may depart from it, but say why.\n\nReturn: a ruling (which position the record best supports, "split" if different parts of the question go different ways, or "unresolved"), your confidence, the points of consensus (claims every side accepts or that survived unchallenged and bear on the question), the remaining dissent (who still disagrees about what), and the cruxes: the open questions that would decide it, each with the evidence that would settle it. Cite ledger ids (like P1.2) for every point.\n\nRecord:\n${JSON.stringify(record, null, 1).slice(0, 60000)}`,
  { label: 'judge', schema: { type: 'object', required: ['ruling', 'winner', 'confidence', 'consensus', 'dissent', 'cruxes'], properties: { ruling: { type: 'string' }, winner: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, consensus: { type: 'array', items: { type: 'string' } }, dissent: { type: 'array', items: { type: 'string' } }, cruxes: { type: 'array', items: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, settled_by: { type: 'string' } } } }, departs_from_tally: { type: 'string' } } } },
)

// ------------------------------------------------------------- Report
const pct = (value) => (typeof value === 'number' ? Math.round(value * 100) + '%' : '?')
const winner = positions.find((position) => position.id === judgement.winner || position.name === judgement.winner)
const lines = [`# Debate: ${question}`, '', `**Ruling** (${pct(judgement.confidence)}): ${judgement.ruling}`]
if (winner && ranked[0] && winner.id !== ranked[0].id && Math.abs(winner.score - ranked[0].score) >= 1) lines.push('', `Note: the judge's ruling differs from the evidence tally, which favours ${ranked[0].id} (${ranked[0].score} vs ${winner.score}). ${judgement.departs_from_tally || ''}`.trim())
lines.push('', '## Positions', '', '| Position | Thesis | Evidence tally | Arguments (outcome) | Confidence, first to last |', '| --- | --- | --- | --- | --- |')
for (const position of positions) lines.push(`| ${position.id} ${position.name}${position.forfeit ? ' (forfeit)' : ''} | ${position.thesis.replace(/\|/g, '/')} | ${position.score ?? 0} | ${Object.entries(position.counts || {}).map(([status, count]) => count + ' ' + status).join(', ') || 'none'} | ${position.confidence.map(pct).join(' → ') || '?'} |`)
lines.push('', '## Consensus', '', ...(judgement.consensus.length ? judgement.consensus.map((item) => '- ' + item) : ['- None.']))
lines.push('', '## Dissent', '', ...(judgement.dissent.length ? judgement.dissent.map((item) => '- ' + item) : ['- None.']))
lines.push('', '## Cruxes', '', ...(judgement.cruxes.length ? judgement.cruxes.map((item) => '- ' + item.question + (item.settled_by ? ' Settled by: ' + item.settled_by : '')) : ['- None identified.']))
const changers = positions.filter((position) => position.wouldChange)
if (changers.length) lines.push('', '## What would change their minds', '', ...changers.map((position) => `- ${position.id}: ${position.wouldChange}`))
lines.push('', '## Argument ledger', '', '| Id | Claim | Source | Outcome |', '| --- | --- | --- | --- |')
for (const entry of ledger) lines.push(`| ${entry.id} | ${entry.claim.replace(/\|/g, '/')}${entry.counters ? ' (answers ' + entry.counters + ')' : ''} | ${entry.url ? '[' + (entry.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]) + '](' + entry.url + ')' : 'reasoning'} | ${entry.status}${entry.concededBy.length ? ' (conceded by ' + entry.concededBy.join(', ') + ')' : ''}${entry.check ? ': ' + entry.check.note.replace(/\|/g, '/') : ''} |`)
lines.push('', `Scoring: supported by an independent fact-check or conceded by an opponent +3, unchallenged or unresolved +1, unsettled +0.5, refuted -2, withdrawn 0; arguments without a source count half. ${rounds} rebuttal round(s), ${disputed.length} fact-check(s).`)
return lines.join('\n')
