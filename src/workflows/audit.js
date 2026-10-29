export const meta = {
  name: 'audit',
  description: 'Run bounded, read-only security, performance, test-coverage, and dependency reviews; deduplicate and verify severe findings',
  phases: ['Independent review', 'Verify severe findings', 'Merge report'],
}

const scope = typeof args === 'string'
  ? args.trim()
  : String((args && (args.scope || args.path || args.prompt)) || '.').trim()
const scopeLabel = scope || '.'

const findingSchema = {
  type: 'object',
  required: ['title', 'severity', 'file', 'line', 'evidence', 'fix', 'confidence'],
  properties: {
    title: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    file: { type: 'string' },
    line: { type: 'integer' },
    evidence: { type: 'string' },
    fix: { type: 'string' },
    confidence: { type: 'number' },
  },
}
const reviewerSchema = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', maxItems: 12, items: findingSchema },
  },
}
const verifierSchema = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['verified', 'unverified'] },
    reason: { type: 'string' },
  },
}

const reviewers = [
  {
    label: 'security reviewer',
    role: 'security',
    focus: 'Trust boundaries, command and file permissions, path traversal, injection, secrets, authentication, network boundaries and unsafe side effects. Report only concrete, exploitable or policy-relevant problems.',
  },
  {
    label: 'performance reviewer',
    role: 'performance',
    focus: 'Algorithmic bottlenecks, pathological loops, blocking I/O, unnecessary work, unbounded buffers, memory growth and resource leaks. Avoid speculative micro-optimizations.',
  },
  {
    label: 'test coverage reviewer',
    role: 'coverage',
    focus: 'Changed or high-risk behavior lacking meaningful regression tests, weak assertions, missing failure/cancellation cases, and tests that do not prove the advertised behavior.',
  },
  {
    label: 'dependency reviewer',
    role: 'dependency',
    focus: 'Dependency lifecycle, versions and ranges, unnecessary dependencies, unsafe installation hooks, stale packages, vulnerable configuration and supply-chain exposure. Do not invent vulnerability claims without evidence.',
  },
]

phase('Independent review')
const results = await parallel(reviewers.map((reviewer) => () => agent(
  [
    'Perform a read-only repository audit. Do not edit files or run commands.',
    'Requested scope: ' + scopeLabel,
    'Review role: ' + reviewer.role,
    'Focus: ' + reviewer.focus,
    'Inspect source and tests using available read-only tools. Prefer LSP symbol/reference navigation when a relevant symbol is known.',
    'Return only evidence-backed findings. Every finding must include a workspace-relative file path, a 1-based line (use 1 when a precise line cannot be determined), concrete evidence, a recommended fix, and confidence from 0 to 1.',
    'Return an empty findings array when no concrete issue is found. Do not return general advice, praise, raw tool logs, or duplicate findings.'
  ].join('\n\n'),
  { label: reviewer.label, agentType: 'explore', schema: reviewerSchema },
)))
const failedReviewers = reviewers.filter((reviewer, index) => !results[index]).map((reviewer) => reviewer.role)
const rawFindings = []
results.forEach((result, index) => {
  for (const item of (result && Array.isArray(result.findings) ? result.findings : []).slice(0, 12)) {
    rawFindings.push({
      ...item,
      role: reviewers[index].role,
      verified: false,
      provenance: [reviewers[index].role],
    })
  }
})

function normalizeTitle(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function normalizeFile(text) {
  return String(text || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}
const severityRank = { critical: 4, high: 3, medium: 2, low: 1 }
const merged = new Map()
for (const item of rawFindings.slice(0, 48)) {
  const title = String(item.title || '').slice(0, 240)
  const file = String(item.file || '').slice(0, 500)
  const line = Number.isInteger(item.line) && item.line > 0 ? item.line : 1
  if (!title || !file || !String(item.evidence || '').trim()) continue
  const key = normalizeFile(file) + ':' + line + ':' + normalizeTitle(title)
  const existing = merged.get(key)
  const normalized = {
    title,
    severity: severityRank[item.severity] ? item.severity : 'medium',
    file,
    line,
    evidence: String(item.evidence || '').slice(0, 1800),
    fix: String(item.fix || '').slice(0, 1200),
    confidence: Math.max(0, Math.min(1, Number.isFinite(item.confidence) ? item.confidence : 0.5)),
    verified: false,
    provenance: [...(item.provenance || [item.role])],
  }
  if (!existing) merged.set(key, normalized)
  else {
    existing.provenance = [...new Set([...existing.provenance, ...normalized.provenance])]
    if (normalized.confidence > existing.confidence) {
      existing.evidence = normalized.evidence
      existing.confidence = normalized.confidence
    } else if (!existing.evidence.includes(normalized.evidence)) {
      existing.evidence = (existing.evidence + '\nAdditional evidence: ' + normalized.evidence).slice(0, 2400)
    }
    if (severityRank[normalized.severity] > severityRank[existing.severity]) existing.severity = normalized.severity
    if (normalized.fix && !existing.fix.includes(normalized.fix)) existing.fix = (existing.fix + '\nAlternative fix: ' + normalized.fix).slice(0, 1600)
  }
}

const findings = [...merged.values()]
const severe = findings.filter((item) => item.severity === 'critical' || item.severity === 'high')
  .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.confidence - a.confidence)
  .slice(0, 4)

phase('Verify severe findings')
const verification = await pipeline(severe, (finding, index) => agent(
  [
    'Independently verify this potential high-severity audit finding using read-only code inspection. Do not edit files or run commands.',
    'Finding: ' + JSON.stringify(finding),
    'Confirm only if the cited code evidence supports the stated defect and its severity. If source evidence is insufficient, return unverified.',
  ].join('\n\n'),
  { label: 'verify finding ' + (index + 1), agentType: 'explore', schema: verifierSchema },
))
const verifyByKey = new Map()
severe.forEach((finding, index) => {
  const result = verification[index]
  const key = normalizeFile(finding.file) + ':' + finding.line + ':' + normalizeTitle(finding.title)
  verifyByKey.set(key, result && result.verdict === 'verified'
    ? { verified: true, verificationNote: String(result.reason || '').slice(0, 800) }
    : { verified: false, verificationNote: String(result && result.reason || 'Independent verification was unavailable or inconclusive.').slice(0, 800) })
})

for (const finding of findings) {
  const key = normalizeFile(finding.file) + ':' + finding.line + ':' + normalizeTitle(finding.title)
  const checked = verifyByKey.get(key)
  if (checked) Object.assign(finding, checked)
  finding.provenance = [...new Set(finding.provenance)]
}
findings.sort((a, b) =>
  severityRank[b.severity] - severityRank[a.severity] ||
  Number(b.verified) - Number(a.verified) ||
  b.confidence - a.confidence ||
  a.file.localeCompare(b.file) ||
  a.line - b.line
)
const limited = findings.slice(0, 25)
const counts = { critical: 0, high: 0, medium: 0, low: 0 }
for (const item of limited) counts[item.severity] += 1
return {
  title: 'OASIS audit report',
  status: failedReviewers.length ? 'partial' : 'completed',
  scope: scopeLabel,
  reviewerCount: reviewers.length,
  reviewersSucceeded: reviewers.length - failedReviewers.length,
  reviewersFailed: failedReviewers,
  verifiedFindings: limited.filter((item) => item.verified),
  unverifiedFindings: limited.filter((item) => !item.verified),
  summary: { total: limited.length, omitted: Math.max(0, findings.length - limited.length), bySeverity: counts },
}
