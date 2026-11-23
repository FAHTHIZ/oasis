export const meta = {
  name: 'factcheck',
  description: 'Fact-check a text, file or web page: extract its checkable claims, give each to an independent checker who must find evidence outside the original source, send every confident verdict to an adversarial reviewer who tries to overturn it, and report a verdict table with corrections',
  phases: ['Extract', 'Check', 'Challenge', 'Verdicts'],
}

// args: "text" | "https://..." | "path/to/file.md" [--max N]
//    or { text?, url?, path?, max_claims?: 1-20 }
const input = typeof args === 'string' ? { raw: args } : (args || {})
let raw = String(input.raw || '').trim()
let max = Math.max(1, Math.min(20, Number(input.max_claims) || 10))
const maxFlag = /(?:^|\s)--max[= ](\d{1,2})\b/.exec(raw)
if (maxFlag) { max = Math.max(1, Math.min(20, Number(maxFlag[1]))); raw = raw.replace(maxFlag[0], ' ').trim() }
let url = String(input.url || '').trim()
let file = String(input.path || '').trim()
let text = String(input.text || '').trim()
if (raw) {
  if (/^https?:\/\/\S+$/i.test(raw)) url = raw
  else if (!/\s/.test(raw) && /^(?:\.{0,2}\/)?[\w@.\-/]+\.(?:md|markdown|txt|html?|rst|adoc|tex|json|csv)$/i.test(raw)) file = raw
  else text = raw
}
if (!url && !file && !text) return 'Usage: /factcheck <text | URL | file> [--max 1-20]  (or args: { text | url | path, max_claims })'

const hostOf = (value) => { const match = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(String(value || '').trim()); return match ? match[1].toLowerCase() : '' }
// A site and its subdomains are one source: news.example.com and example.com.
const siteOf = (value) => { const parts = hostOf(value).split('.').filter(Boolean); const secondLevel = parts.length > 2 && parts[parts.length - 1].length === 2 && /^(?:co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]); return parts.slice(secondLevel ? -3 : -2).join('.') }
const originSite = url ? siteOf(url) : ''
const EVIDENCE_RULES = 'Evidence rules (OASIS enforces them and rejects reports that break them): cite only pages you fetched with fetch_url in this run; give a short verbatim quote from the page for each piece of evidence and check it with verify_quote first; pages that copy the same story are one source (source_independence).'
const evidenceSchema = { type: 'array', maxItems: 4, items: { type: 'object', required: ['url', 'quote', 'stance'], properties: { url: { type: 'string' }, quote: { type: 'string' }, stance: { type: 'string', enum: ['supports', 'refutes', 'context'] } } } }
const VERDICTS = ['true', 'mostly-true', 'misleading', 'false', 'unverifiable']

// -------------------------------------------------------------- Extract
phase('Extract')
const source = url ? `the web page ${url} (fetch it with fetch_url)` : file ? `the file ${file} (read it)` : 'the text below'
const extracted = await agent(
  `Extract the checkable factual claims from ${source}.\n\nA checkable claim is a statement about the world that evidence could confirm or refute: figures, dates, events, attributions ("X said Y"), causal or comparative claims, descriptions of studies or laws. Opinions, predictions, advice and definitions are not checkable; list a few of them separately.\n\nFor each claim:\n- claim: rewrite it to stand alone (resolve "it", "the company", "last year" to what they mean; keep the original figures and wording of what is asserted, and do not soften or strengthen it)\n- excerpt: the sentence of the original it comes from, verbatim\n- kind: number, date, event, attribution, causal, comparison, study, legal or other\n- checkworthiness: 0 to 1, how much the text depends on it and how much harm being wrong would do\n- what_would_verify: the kind of source that would settle it (a primary record, the study itself, the official statistic)\nSplit compound sentences into separate claims. Return at most ${Math.min(30, max * 2)} claims.` + (text ? `\n\nText:\n"""\n${text.slice(0, 30000)}\n"""` : ''),
  { label: 'extract claims', schema: { type: 'object', required: ['claims'], properties: { title: { type: 'string' }, claims: { type: 'array', maxItems: 30, items: { type: 'object', required: ['claim', 'checkworthiness'], properties: { claim: { type: 'string' }, excerpt: { type: 'string' }, kind: { type: 'string' }, checkworthiness: { type: 'number', minimum: 0, maximum: 1 }, what_would_verify: { type: 'string' } } } }, not_checkable: { type: 'array', maxItems: 8, items: { type: 'string' } } } } },
)
const seen = new Set()
const claims = extracted.claims
  .filter((item) => { const key = String(item.claim || '').toLowerCase().replace(/\W+/g, ' ').trim(); if (!key || seen.has(key)) return false; seen.add(key); return true })
  .sort((a, b) => (b.checkworthiness || 0) - (a.checkworthiness || 0))
  .slice(0, max)
  .map((item, index) => ({ id: 'C' + (index + 1), claim: String(item.claim).slice(0, 600), excerpt: String(item.excerpt || '').slice(0, 400), kind: String(item.kind || 'other'), weight: Math.max(0.05, Math.min(1, Number(item.checkworthiness) || 0.5)), settle: String(item.what_would_verify || '').slice(0, 300) }))
log(`${claims.length} claims to check (of ${extracted.claims.length} extracted)` + (extracted.not_checkable && extracted.not_checkable.length ? `; ${extracted.not_checkable.length} not checkable` : ''))
if (!claims.length) return `# Fact-check: ${extracted.title || url || file || 'text'}\n\nNo checkable factual claims found.` + (extracted.not_checkable && extracted.not_checkable.length ? '\n\nNot checkable (opinion, prediction or advice):\n' + extracted.not_checkable.map((item) => '- ' + item).join('\n') : '')

// ---------------------------------------------------------------- Check
// One checker per claim. Each sees only its claim: not the rest of the text,
// not other verdicts. The original source cannot vouch for itself.
phase('Check')
const exclusion = url ? `\nThe claim comes from ${url}. That page, and anything else on ${originSite}, does not count as evidence for it: find independent sources.` : file ? `\nThe claim comes from ${file}; the file itself is not evidence.` : ''
const checks = await pipeline(claims, (item) => agent(
  `Fact-check one claim, independently.\nClaim (${item.kind}): ${item.claim}` + (item.excerpt ? `\nAs written: "${item.excerpt}"` : '') + (item.settle ? `\nWhat would settle it: ${item.settle}` : '') + exclusion + `\n\nSearch, fetch and read the best sources you can find, primary ones first (the study, the record, the official statistic, the full quote in context). Verdict:\n- true: reliable independent sources state it\n- mostly-true: right in substance, with a minor error (a rounded figure, a slightly wrong date)\n- misleading: literally accurate but missing context that changes what a reader would conclude\n- false: reliable sources contradict it\n- unverifiable: you could not find reliable evidence either way\nGive the evidence (url, verbatim quote, and whether it supports, refutes or adds context), your confidence 0 to 1, a one-sentence note, and for anything not true, the correction: what is actually the case. ${EVIDENCE_RULES}`,
  { label: 'check ' + item.id, schema: { type: 'object', required: ['verdict', 'note', 'confidence'], properties: { verdict: { type: 'string', enum: VERDICTS }, confidence: { type: 'number', minimum: 0, maximum: 1 }, note: { type: 'string' }, correction: { type: 'string' }, evidence: evidenceSchema } } },
))
let circular = 0
claims.forEach((item, index) => {
  const check = checks[index]
  if (!check) { Object.assign(item, { verdict: 'unverifiable', confidence: 0, note: 'The checker failed or its report did not pass the evidence checks.', evidence: [], failed: true }); return }
  const all = Array.isArray(check.evidence) ? check.evidence : []
  // Mechanical rule: evidence from the claim's own site is circular.
  const evidence = all.filter((entry) => !originSite || siteOf(entry.url) !== originSite)
  circular += all.length - evidence.length
  Object.assign(item, { verdict: check.verdict, confidence: check.confidence, note: String(check.note || ''), correction: String(check.correction || ''), evidence })
  item.sites = [...new Set(evidence.map((entry) => siteOf(entry.url)).filter(Boolean))]
  if (['true', 'mostly-true', 'false', 'misleading'].includes(item.verdict) && !evidence.some((entry) => entry.stance !== 'context')) {
    item.note = `Downgraded from ${item.verdict}: no independent evidence behind it${all.length > evidence.length ? ' (only the original source)' : ''}. ` + item.note
    item.verdict = 'unverifiable'
    item.confidence = null
  }
})
log(`checked ${claims.length}` + (circular ? `; ${circular} piece(s) of evidence from the original source discounted` : ''))

// ------------------------------------------------------------ Challenge
// Every confident verdict goes to a reviewer whose only job is to overturn it.
phase('Challenge')
const contestable = claims.filter((item) => !item.failed && ['true', 'mostly-true', 'false', 'misleading'].includes(item.verdict)).slice(0, 12)
const challenges = await pipeline(contestable, (item) => agent(
  `A fact-checker ruled on a claim. Your job is to try to overturn the ruling: look for the strongest evidence that it is wrong (a primary source that says otherwise, a more recent figure, missing context, a misread study, a quote taken out of context). You are scored on finding real errors, not on agreeing, and also not on inventing doubt: if the ruling holds, say so.\nClaim: ${item.claim}\nRuling: ${item.verdict} (confidence ${item.confidence}). ${item.note}${item.correction ? ' Correction given: ' + item.correction : ''}\nEvidence used:\n${item.evidence.map((entry) => '- ' + entry.stance + ': ' + entry.url + ' "' + String(entry.quote || '').slice(0, 200) + '"').join('\n')}` + exclusion + `\n\nstrength "strong" only if you fetched reliable evidence that contradicts the ruling; "weak" for a real but inconclusive concern; "none" if the ruling holds. If you overturn it, give the verdict you think is right. ${EVIDENCE_RULES}`,
  { label: 'challenge ' + item.id, schema: { type: 'object', required: ['strength', 'note'], properties: { strength: { type: 'string', enum: ['none', 'weak', 'strong'] }, note: { type: 'string' }, verdict: { type: 'string', enum: VERDICTS }, evidence: evidenceSchema } } },
))
contestable.forEach((item, index) => {
  const challenge = challenges[index]
  if (!challenge) return
  const evidence = (Array.isArray(challenge.evidence) ? challenge.evidence : []).filter((entry) => !originSite || siteOf(entry.url) !== originSite)
  item.challenge = { strength: challenge.strength, note: String(challenge.note || ''), verdict: challenge.verdict || '', evidence }
  if (challenge.strength === 'strong' && evidence.length && challenge.verdict && challenge.verdict !== item.verdict) {
    item.firstVerdict = item.verdict
    item.verdict = 'disputed'
  } else if (challenge.strength === 'weak') item.confidence = Math.round(Math.min(item.confidence, 0.6) * 100) / 100
})
const overturned = contestable.filter((item) => item.verdict === 'disputed').length
log(`challenged ${contestable.length}: ${overturned} disputed, ${contestable.filter((item) => item.challenge && item.challenge.strength === 'none').length} held`)

// ------------------------------------------------------------- Verdicts
phase('Verdicts')
// Reliability: how much of the checkable content held up, weighted by how
// much the text depends on each claim. Unverifiable and disputed claims are
// left out of the ratio and reported separately.
const CREDIT = { true: 1, 'mostly-true': 0.8, misleading: 0.3, false: 0 }
const scored = claims.filter((item) => Object.hasOwn(CREDIT, item.verdict))
const weightSum = scored.reduce((sum, item) => sum + item.weight, 0)
const reliability = weightSum ? Math.round(scored.reduce((sum, item) => sum + item.weight * CREDIT[item.verdict], 0) / weightSum * 100) : null
const count = (verdict) => claims.filter((item) => item.verdict === verdict).length
const pct = (value) => (typeof value === 'number' ? Math.round(value * 100) + '%' : '-')
const link = (entry) => '[' + hostOf(entry.url) + '](' + entry.url + ')'
const lines = [`# Fact-check: ${extracted.title || url || file || 'text'}`, '']
lines.push(`${claims.length} claim${claims.length === 1 ? '' : 's'} checked: ${['true', 'mostly-true', 'misleading', 'false', 'disputed', 'unverifiable'].map((verdict) => count(verdict) + ' ' + verdict).filter((item) => !item.startsWith('0 ')).join(', ')}.` + (reliability === null ? ' Nothing could be verified either way.' : ` Weighted reliability of what could be checked: ${reliability}%.`))
lines.push('', '| Id | Claim | Verdict | Confidence | Evidence |', '| --- | --- | --- | --- | --- |')
for (const item of claims) {
  const evidence = item.evidence && item.evidence.length ? item.evidence.map((entry) => link(entry) + (entry.stance === 'supports' ? '' : ' (' + entry.stance + ')')).join(', ') : 'none'
  lines.push(`| ${item.id} | ${item.claim.replace(/\|/g, '/')} | ${item.verdict}${item.firstVerdict ? ' (checker: ' + item.firstVerdict + ', reviewer: ' + item.challenge.verdict + ')' : ''} | ${pct(item.confidence)} | ${evidence} |`)
}
const corrections = claims.filter((item) => item.correction && ['mostly-true', 'misleading', 'false', 'disputed'].includes(item.verdict))
if (corrections.length) lines.push('', '## Corrections', '', ...corrections.map((item) => `- ${item.id}: ${item.correction}`))
const disputes = claims.filter((item) => item.verdict === 'disputed')
if (disputes.length) lines.push('', '## Disputed', '', 'The checker and the adversarial reviewer disagree; both found evidence. Treat these as open.', '', ...disputes.map((item) => `- ${item.id}: checker said ${item.firstVerdict} (${item.note.replace(/\s+/g, ' ').slice(0, 300)}); reviewer said ${item.challenge.verdict} (${item.challenge.note.replace(/\s+/g, ' ').slice(0, 300)})` + (item.challenge.evidence.length ? ' ' + item.challenge.evidence.map(link).join(', ') : '')))
lines.push('', '## Notes per claim', '', ...claims.map((item) => `- ${item.id} (${item.kind}${item.sites && item.sites.length ? ', ' + item.sites.length + ' independent site' + (item.sites.length === 1 ? '' : 's') : ''}): ${item.note.replace(/\s+/g, ' ')}` + (item.challenge && item.challenge.strength !== 'none' && item.verdict !== 'disputed' ? ` Reviewer (${item.challenge.strength}): ${item.challenge.note.replace(/\s+/g, ' ')}` : '')))
if (extracted.not_checkable && extracted.not_checkable.length) lines.push('', '## Not checkable', '', 'Opinion, prediction or advice in the text, not assessed:', '', ...extracted.not_checkable.map((item) => '- ' + item))
lines.push('', `Method: claims were rewritten to stand alone and ranked by how much the text depends on them; each went to its own checker who saw nothing else${originSite ? ', and evidence from ' + originSite + ' (the original source) did not count' : ''}. Confident verdicts were sent to an adversarial reviewer; a strong, evidenced objection marks a claim disputed and a weak one caps its confidence at 60%. A verdict with no independent evidence is reported as unverifiable. Reliability weights true 1, mostly-true 0.8, misleading 0.3, false 0 by checkworthiness.`)
return lines.join('\n')
