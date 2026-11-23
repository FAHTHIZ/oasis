export const meta = {
  name: 'deep-research',
  description: 'Fan out web searches across several angles, fetch and cross-check sources (verified quotes, independent-source counts), vote on each claim, and return a cited report',
  phases: ['Plan', 'Research', 'Cross-check', 'Report'],
}

const question = typeof args === 'string' ? args.trim() : String((args && (args.question || args.prompt)) || '').trim()
if (!question) return 'Usage: /deep-research <question>'

phase('Plan')
const plan = await agent(
  `Plan research for this question: ${question}\n\nList 3 to 6 distinct search angles (sub-questions, stakeholders, time periods, primary vs secondary sources) that together would answer it thoroughly. Do not research yet.`,
  { label: 'plan angles', agentType: 'Explore', schema: { type: 'object', required: ['angles'], properties: { angles: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } } } } },
)

phase('Research')
const findings = await pipeline(plan.angles.slice(0, 6), (angle) => agent(
  `Research one angle of a larger question.\nQuestion: ${question}\nAngle: ${angle}\n\nUse web_search to find sources and fetch_url to read the most relevant ones. Prefer primary sources (official docs, changelogs, papers, filings). Return up to 8 specific, checkable factual claims, each with the URLs that support it and a short verbatim quote from one of them that states it (check it with verify_quote; leave quote empty rather than paraphrase).`,
  { label: angle, schema: { type: 'object', required: ['claims'], properties: { claims: { type: 'array', maxItems: 8, items: { type: 'object', required: ['claim', 'sources'], properties: { claim: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' } } } } } } },
))
const claims = findings.filter(Boolean).flatMap((item) => item.claims || []).slice(0, 40)
log(`${claims.length} claims from ${findings.filter(Boolean).length} of ${plan.angles.length} angles`)

phase('Cross-check')
const votes = await pipeline(claims, (item, index) => agent(
  `Independently verify one claim. Fetch its sources with fetch_url (and search for another source if they are weak).\nClaim: ${item.claim}\nSources: ${(item.sources || []).join(', ')}${item.quote ? `\nQuoted as: "${item.quote}"` : ''}\n\nverdict "supported" only if a source you read states it (call verify_quote on the quote you rely on); "refuted" if a reliable source contradicts it; "unverifiable" if you could not check it. Then call source_independence on every URL that supports it and report independent_sources: pages on one site, or syndicated copies of one story or press release, count once. If that is 1, search for a source that reported it independently before you answer.`,
  { label: `claim ${index + 1}`, schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['supported', 'refuted', 'unverifiable'] }, note: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' }, independent_sources: { type: 'integer', minimum: 0 } } } },
))
const supported = []
const unverified = []
let refuted = 0
claims.forEach((item, index) => {
  const vote = votes[index]
  if (vote && vote.verdict === 'supported') supported.push({ claim: item.claim, sources: [...new Set([...(item.sources || []), ...(vote.sources || [])])], ...(vote.quote || item.quote ? { quote: vote.quote || item.quote } : {}), independent_sources: vote.independent_sources || 1 })
  else if (vote && vote.verdict === 'refuted') refuted += 1
  else unverified.push(item.claim)
})
const singleSource = supported.filter((item) => item.independent_sources < 2).length
log(`${supported.length} supported (${supported.length - singleSource} by independent sources, ${singleSource} single-source), ${refuted} refuted (dropped), ${unverified.length} unverified`)

phase('Report')
const report = await agent(
  `Write a concise research report that answers: ${question}\n\nUse only these cross-checked claims, and cite each with markdown links to its sources. Where a claim has a quote, you may quote it word for word; never alter a quote. Say "according to <source>" for claims with independent_sources 1, and only call a claim confirmed or corroborated when independent_sources is 2 or more:\n${JSON.stringify(supported, null, 2)}\n\nEnd with a short "Unverified" list of these claims, which could not be checked:\n${JSON.stringify(unverified)}\n\nDo not use tools; just write the report.`,
  { label: 'write report' },
)
return report
