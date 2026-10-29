import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export async function saveComparisonArtifact(outputPath, content) {
  const resolved = path.resolve(String(outputPath));
  if (!path.basename(resolved) || resolved === path.parse(resolved).root) {
    throw new Error('Comparison report output must name a file, not a filesystem root.');
  }
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const existing = await lstat(resolved).catch((error) => {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('Comparison report output must be a regular, non-symlink file: ' + outputPath);
  }
  await writeFile(resolved, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(resolved, 0o600).catch(() => {});
  return resolved;
}

export function renderComparisonHtml(comparison) {
  const left = comparison.sources[0];
  const right = comparison.sources[1];
  const aLabel = escapeHtml(left.label);
  const bLabel = escapeHtml(right.label);
  const percent = (value) => value === null || value === undefined ? 'n/a' : (value * 100).toFixed(1) + '%';
  const milliseconds = (value) => value === null || value === undefined ? 'n/a' : Math.round(value).toLocaleString('en-US') + ' ms';
  const dollars = (value) => value === null || value === undefined ? 'n/a' : '$' + value.toFixed(6);
  const bar = (value) => {
    if (value === null || value === undefined) return '<p class="na">Not available</p>';
    const width = Math.max(0, Math.min(100, value * 100));
    return '<div class="bar" role="img" aria-label="' + width.toFixed(1) + '%"><span style="width:' + width + '%"></span></div>';
  };
  const rateCard = (title, key) =>
    '<article class="metric"><h2>' + escapeHtml(title) + '</h2>' +
    '<div class="model-value"><span>A · ' + aLabel + '</span><strong>' + percent(comparison.metrics.a[key]) + '</strong></div>' +
    bar(comparison.metrics.a[key]) +
    '<div class="model-value"><span>B · ' + bLabel + '</span><strong>' + percent(comparison.metrics.b[key]) + '</strong></div>' +
    bar(comparison.metrics.b[key]) + '</article>';
  const scalarCard = (title, key, formatter) =>
    '<article class="metric"><h2>' + escapeHtml(title) + '</h2>' +
    '<div class="model-value"><span>A · ' + aLabel + '</span><strong>' + formatter(comparison.metrics.a[key]) + '</strong></div>' +
    '<div class="model-value"><span>B · ' + bLabel + '</span><strong>' + formatter(comparison.metrics.b[key]) + '</strong></div></article>';
  const caveats = comparison.caveats.map((caveat) => '<li>' + escapeHtml(caveat) + '</li>').join('\n');
  const taskRows = comparison.tasks.map((row) =>
    '<tr><th scope="row">' + escapeHtml(row.taskId) + '</th>' +
    '<td>' + escapeHtml(row.category || 'uncategorized') + '</td>' +
    '<td>' + escapeHtml(row.difficulty || 'unspecified') + '</td>' +
    '<td>' + row.left.passed + '/' + row.left.trials + ' (' + percent(row.left.passRate) + ')</td>' +
    '<td>' + row.right.passed + '/' + row.right.trials + ' (' + percent(row.right.passRate) + ')</td>' +
    '<td>' + milliseconds(row.left.medianWallTimeMs) + '</td>' +
    '<td>' + milliseconds(row.right.medianWallTimeMs) + '</td>' +
    '<td>' + (row.fingerprintStatus === 'verified' ? 'Verified' : 'Legacy / unverified') + '</td></tr>'
  ).join('\n');
  const outcomes = comparison.pairedTaskOutcomes;
  const sourceLine = (source) => '<li><strong>' + escapeHtml(source.label) + '</strong> · revision <code>' +
    escapeHtml(source.revision || 'unavailable') + '</code></li>';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>OASIS Arena comparison</title>',
    '<style>',
    ':root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101411;color:#edf3ed}',
    '*{box-sizing:border-box}body{margin:0;background:#101411;color:#edf3ed;line-height:1.5}',
    'main{max-width:1240px;margin:0 auto;padding:clamp(16px,4vw,40px)}',
    'header{border-bottom:1px solid #374239;padding-bottom:22px;margin-bottom:24px}h1{font-size:clamp(1.7rem,4vw,2.6rem);margin:0 0 8px}h2{font-size:1rem;margin:0 0 14px}p{color:#c3cec3;margin:8px 0}',
    '.eyebrow{color:#a5f279;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:700}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:14px;margin:18px 0}',
    '.metric,.panel{background:#181f1a;border:1px solid #344137;border-radius:14px;padding:18px;min-width:0}',
    '.model-value{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:10px 0 5px}.model-value span{color:#c3cec3;overflow-wrap:anywhere}.model-value strong{font-size:1.05rem;white-space:nowrap}',
    '.bar{height:7px;background:#303a32;border-radius:20px;overflow:hidden}.bar span{display:block;height:100%;background:#a5f279;border-radius:20px}.na{font-size:.85rem;color:#adb9ad}',
    '.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.stat{padding:12px;background:#202a22;border-radius:10px}.stat strong{display:block;font-size:1.35rem}.stat span{font-size:.82rem;color:#c3cec3}',
    '.warning{border-color:#7d6936;background:#29251a}.warning h2{color:#f3d487}.warning ul{padding-left:22px}.warning li{margin:8px 0}',
    '.table-wrap{overflow-x:auto;border:1px solid #344137;border-radius:12px}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:.9rem}caption{text-align:left;padding:14px;font-weight:700}th,td{text-align:left;padding:11px 12px;border-top:1px solid #303a32}th{font-weight:650}thead th{background:#202a22}code{font-size:.85em;overflow-wrap:anywhere}',
    '.sources{padding-left:22px}.sources li{margin:8px 0}footer{font-size:.85rem;color:#adb9ad;margin-top:26px}',
    '@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}@media print{body{background:#fff;color:#111}.metric,.panel,.stat{background:#fff;color:#111;border-color:#bbb}.model-value span,p,footer,.eyebrow,.warning h2{color:#333}.bar{background:#ddd}.bar span{background:#555}}',
    '</style></head><body><main>',
    '<header><div class="eyebrow">OASIS Arena · evaluation report</div><h1>Side-by-side coding evaluation</h1>',
    '<p>Matched tasks only · generated ' + escapeHtml(comparison.comparedAt) + ' · observed outcomes, not a guarantee of general coding parity.</p>',
    '<div class="summary"><div class="stat"><strong>' + comparison.commonTaskCount + '</strong><span>matched tasks</span></div>',
    '<div class="stat"><strong>' + comparison.metrics.a.trialCount + '</strong><span>A trials</span></div><div class="stat"><strong>' + comparison.metrics.b.trialCount + '</strong><span>B trials</span></div>',
    '<div class="stat"><strong>' + outcomes.aWins + ' / ' + outcomes.bWins + ' / ' + outcomes.ties + '</strong><span>A wins / B wins / ties</span></div></div></header>',
    '<section aria-label="Headline metrics"><div class="grid">',
    rateCard('Task-balanced pass rate', 'taskBalancedPassRate'),
    rateCard('Category-balanced pass rate', 'categoryBalancedPassRate'),
    rateCard('Difficulty-balanced pass rate', 'difficultyBalancedPassRate'),
    scalarCard('Median task time', 'medianTaskWallTimeMs', milliseconds),
    scalarCard('Mean cost per task/trial', 'meanCostPerTrialUSD', dollars),
    '</div></section>',
    '<section class="panel warning" aria-labelledby="caveats-title"><h2 id="caveats-title">Interpretation guardrails</h2><ul>' + caveats + '</ul></section>',
    '<section class="panel" style="margin-top:18px" aria-labelledby="sources-title"><h2 id="sources-title">Run provenance</h2><ul class="sources">' + sourceLine(left) + sourceLine(right) + '</ul>',
    '<p>Only tasks with compatible IDs, metadata, and fingerprints contribute to headline scores. Legacy tasks without matching verified fingerprints are explicitly marked unverified.</p></section>',
    '<section aria-labelledby="tasks-title" style="margin-top:24px"><h2 id="tasks-title">Task-by-task outcomes</h2><div class="table-wrap"><table><caption>Per-task observed success, time, and fingerprint status</caption>',
    '<thead><tr><th scope="col">Task</th><th scope="col">Category</th><th scope="col">Difficulty</th><th scope="col">A pass rate</th><th scope="col">B pass rate</th><th scope="col">A median time</th><th scope="col">B median time</th><th scope="col">Task definition</th></tr></thead>',
    '<tbody>' + taskRows + '</tbody></table></div></section>',
    '<footer>Generated by OASIS evaluation tooling. Task wins are descriptive comparisons of observed per-task pass rates—not a statistical significance test. Keep the original run JSON files with this report.</footer>',
    '</main></body></html>'
  ].join('\n') + '\n';
}