export const meta = {
  name: 'deep-research',
  description: 'Fan out web searches across several angles, fetch and cross-check sources, vote on each claim, and return a cited report',
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
  `Research one angle of a larger question.\nQuestion: ${question}\nAngle: ${angle}\n\nUse web_search to find sources and fetch_url to read the most relevant ones. Prefer primary sources (official docs, changelogs, papers, filings). Return up to 8 specific, checkable factual claims, each with the URLs that support it.`,
  { label: angle, schema: { type: 'object', required: ['claims'], properties: { claims: { type: 'array', maxItems: 8, items: { type: 'object', required: ['claim', 'sources'], properties: { claim: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } } } } } } },
))
const claims = findings.filter(Boolean).flatMap((item) => item.claims || []).slice(0, 40)
log(`${claims.length} claims from ${findings.filter(Boolean).length} of ${plan.angles.length} angles`)

phase('Cross-check')
const votes = await pipeline(claims, (item, index) => agent(
  `Independently verify one claim. Fetch its sources with fetch_url (and search for another source if they are weak).\nClaim: ${item.claim}\nSources: ${item.sources.join(', ')}\n\nverdict "supported" only if a source you read states it; "refuted" if a reliable source contradicts it; "unverifiable" if you could not check it.`,
  { label: `claim ${index + 1}`, schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['supported', 'refuted', 'unverifiable'] }, note: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } } } },
))
const supported = []
const unverified = []
let refuted = 0
claims.forEach((item, index) => {
  const vote = votes[index]
  if (vote && vote.verdict === 'supported') supported.push({ claim: item.claim, sources: [...new Set([...(item.sources || []), ...(vote.sources || [])])] })
  else if (vote && vote.verdict === 'refuted') refuted += 1
  else unverified.push(item.claim)
})
log(`${supported.length} supported, ${refuted} refuted (dropped), ${unverified.length} unverified`)

phase('Report')
const report = await agent(
  `Write a concise research report that answers: ${question}\n\nUse only these cross-checked claims, and cite each with markdown links to its sources:\n${JSON.stringify(supported, null, 2)}\n\nEnd with a short "Unverified" list of these claims, which could not be checked:\n${JSON.stringify(unverified)}\n\nDo not use tools; just write the report.`,
  { label: 'write report' },
)
return report
