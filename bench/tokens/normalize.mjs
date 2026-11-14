// The system prompt carries host facts (kernel release, Node patch version,
// today's date, the temp workspace path). They are real prompt content, but
// they differ between this machine and CI, so the same code measured 264,431
// tokens locally and 264,657 on GitHub Actions and failed the 2% gate. Count
// them as fixed stand-ins of typical length so the gate measures Oasis only.
// The same applies to random ids and test timings in tool results.
export const CANONICAL_ROOT = '/tmp/oasis-token-bench';
export function hostIndependent(text, root = CANONICAL_ROOT) {
  let out = String(text);
  if (root && root !== CANONICAL_ROOT) out = out.split(JSON.stringify(root).slice(1, -1)).join(CANONICAL_ROOT);
  return out
    .replace(/Platform: [a-z0-9]+ [^\s"\\]+ \(([a-z0-9_]+)\), Node v[0-9.]+/g, 'Platform: linux 6.8.0-1000 ($1), Node v22.0.0')
    .replace(/Today's date: \d{4}-\d{2}-\d{2}/g, "Today's date: 2026-01-01")
    // Per-run random ids and wall-clock timings change how BPE splits them.
    .replace(/\.oasis\/scratch\/[0-9a-f]{8}\//g, '.oasis/scratch/0a1b2c3d/')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
    .replace(/duration_ms:? \d+\.\d+/g, (m) => m.replace(/\d+\.\d+/, '12.345678'));
}
