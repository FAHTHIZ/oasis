// security_scan: runs the established open-source scanners that are installed
// and returns one normalized, severity-sorted list of findings.
//
//   gitleaks     secrets in files and in git history (values always redacted)
//   osv-scanner  dependencies with known vulnerabilities (OSV database)
//   npm audit    npm dependencies, when osv-scanner is missing
//   pip-audit    Python dependencies, when osv-scanner is missing
//   semgrep      risky code patterns (the project's rules, else p/default)
//   trivy        infrastructure-as-code misconfigurations and dependencies
//
// Each scanner runs through runWorkspaceCommand, so the usual approval
// prompts, permission rules, the OS sandbox and cancellation apply. Reports are
// written to a private temp folder; no secret value or matched source line is
// ever returned to the model.
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onPathSync } from './clipboard-path.mjs';

export const SECURITY_SCAN_TOOL_DEFINITION = { type: 'function', function: {
  name: 'security_scan',
  description: 'Run the installed open-source security scanners and get one normalized list of findings: gitleaks (secrets, including git history; values are redacted), osv-scanner or npm audit / pip-audit (dependencies with known CVEs), semgrep (risky code patterns) and trivy (IaC misconfigurations). Reports which scanners are missing and how to install them. Use it at the start of a security review, before a release, or after adding dependencies. Findings are candidates: confirm each in the code before reporting it.',
  parameters: { type: 'object', properties: {
    scanners: { type: 'array', items: { type: 'string', enum: ['gitleaks', 'osv-scanner', 'npm-audit', 'pip-audit', 'semgrep', 'trivy'] }, description: 'Subset to run; default: every installed scanner that applies' },
    path: { type: 'string', description: 'Workspace-relative directory to scan; default .' },
    history: { type: 'boolean', description: 'gitleaks: also scan git history (default true in a git repository)' },
    max_findings: { type: 'integer', description: '1-500; default 150' }
  }, additionalProperties: false } } };

const INSTALL = {
  gitleaks: 'brew install gitleaks, winget install Gitleaks.Gitleaks, or a release from https://github.com/gitleaks/gitleaks/releases',
  'osv-scanner': 'brew install osv-scanner, winget install Google.OSVScanner, or a release from https://github.com/google/osv-scanner/releases',
  'pip-audit': 'pipx install pip-audit',
  semgrep: 'pipx install semgrep (or brew install semgrep)',
  trivy: 'brew install trivy, or https://trivy.dev/latest/getting-started/installation/',
  'npm-audit': 'comes with npm'
};

const RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4, info: 5 };

function cvssBand(score) {
  const value = Number.parseFloat(score);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  return value >= 9 ? 'critical' : value >= 7 ? 'high' : value >= 4 ? 'medium' : 'low';
}

function wordBand(word) {
  const value = String(word || '').toLowerCase();
  if (value === 'critical') return 'critical';
  if (value === 'high' || value === 'error') return 'high';
  if (value === 'moderate' || value === 'medium' || value === 'warning') return 'medium';
  if (value === 'low') return 'low';
  if (value === 'info' || value === 'informational') return 'info';
  return 'unknown';
}

function rel(workspace, file) {
  if (!file) return '';
  const absolute = path.isAbsolute(file) ? file : path.join(workspace, file);
  return (path.relative(workspace, absolute) || '.').split(path.sep).join('/');
}

const clip = (value, max = 240) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};

async function readJson(file) {
  try {
    const info = await stat(file);
    if (info.size > 64 * 1024 * 1024) return { tooLarge: true };
    return { value: JSON.parse(await readFile(file, 'utf8')) };
  } catch (error) { return { error: error.code === 'ENOENT' ? 'no report was written' : error.message }; }
}

// Test data, examples and vendored/minified bundles produce most false positives.
const FIXTURE_PATH = /(^|\/)(tests?|__tests__|spec|fixtures?|testdata|examples?|mocks?|vendor|third_party|node_modules)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.min\.js$|(^|\/)docs?\//i;

export function parseGitleaks(report, workspace) {
  return (Array.isArray(report) ? report : []).map((item) => ({
    scanner: 'gitleaks',
    // generic-api-key is entropy based and noisy; provider-specific rules are not.
    severity: /^generic/.test(String(item.RuleID || '')) ? 'medium' : 'high',
    ...(FIXTURE_PATH.test(String(item.File || '').split(path.sep).join('/')) ? { likely_fixture: true } : {}),
    rule: String(item.RuleID || 'secret'),
    title: clip(item.Description || 'Possible secret'),
    file: rel(workspace, item.File),
    line: Number(item.StartLine) || undefined,
    ...(item.Commit ? { commit: String(item.Commit).slice(0, 12), in_history: true } : {}),
    fix: item.Commit ? 'Revoke and rotate the credential first; removing it from the latest commit does not remove it from history.' : 'Move the value to an environment variable or secret store, and rotate it if it was ever shared or pushed.'
  }));
}

function fixedVersions(vuln, name) {
  const out = new Set();
  for (const affected of Array.isArray(vuln.affected) ? vuln.affected : []) {
    if (affected.package && affected.package.name && affected.package.name !== name) continue;
    for (const range of Array.isArray(affected.ranges) ? affected.ranges : []) {
      for (const event of Array.isArray(range.events) ? range.events : []) if (event.fixed) out.add(String(event.fixed));
    }
  }
  return [...out].slice(0, 3);
}

export function parseOsv(report, workspace) {
  const findings = [];
  for (const result of Array.isArray(report && report.results) ? report.results : []) {
    const source = rel(workspace, result.source && result.source.path);
    for (const pkg of Array.isArray(result.packages) ? result.packages : []) {
      const name = pkg.package && pkg.package.name;
      const version = pkg.package && pkg.package.version;
      const vulns = new Map((Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : []).map((v) => [v.id, v]));
      for (const group of Array.isArray(pkg.groups) && pkg.groups.length ? pkg.groups : [...vulns.keys()].map((id) => ({ ids: [id] }))) {
        const vuln = vulns.get(group.ids[0]) || {};
        const aliases = (group.aliases || vuln.aliases || []).filter((id) => /^CVE-/.test(id));
        const fixed = fixedVersions(vuln, name);
        findings.push({
          scanner: 'osv-scanner',
          severity: cvssBand(group.max_severity),
          rule: group.ids[0],
          ...(aliases.length ? { cve: aliases.slice(0, 3) } : {}),
          title: clip(vuln.summary || vuln.details || 'Known vulnerability'),
          package: name + '@' + version + (pkg.package && pkg.package.ecosystem ? ' (' + pkg.package.ecosystem + ')' : ''),
          file: source,
          ...(fixed.length ? { fix: 'Upgrade ' + name + ' to ' + fixed.join(' or ') + ' or later.' } : {})
        });
      }
    }
  }
  return findings;
}

export function parseNpmAudit(report) {
  const findings = [];
  for (const [name, entry] of Object.entries(report && report.vulnerabilities || {})) {
    const advisories = (Array.isArray(entry.via) ? entry.via : []).filter((via) => via && typeof via === 'object');
    if (!advisories.length) continue; // only transitive "via" another package; reported under that package
    for (const advisory of advisories.slice(0, 5)) {
      findings.push({
        scanner: 'npm-audit',
        severity: wordBand(advisory.severity || entry.severity),
        rule: String(advisory.url || advisory.source || name).replace('https://github.com/advisories/', ''),
        title: clip(advisory.title || 'Known vulnerability'),
        package: name + (advisory.range ? ' ' + advisory.range : ''),
        file: 'package-lock.json',
        ...(entry.fixAvailable ? { fix: entry.fixAvailable === true ? 'npm audit fix' : 'Upgrade ' + (entry.fixAvailable.name || name) + ' to ' + (entry.fixAvailable.version || 'a fixed version') + (entry.fixAvailable.isSemVerMajor ? ' (major version change)' : '') + '.' } : {})
      });
    }
  }
  return findings;
}

export function parsePipAudit(report) {
  const findings = [];
  for (const dep of Array.isArray(report && report.dependencies) ? report.dependencies : []) {
    for (const vuln of Array.isArray(dep.vulns) ? dep.vulns : []) {
      findings.push({
        scanner: 'pip-audit',
        severity: 'unknown',
        rule: vuln.id,
        ...(Array.isArray(vuln.aliases) && vuln.aliases.some((id) => /^CVE-/.test(id)) ? { cve: vuln.aliases.filter((id) => /^CVE-/.test(id)).slice(0, 3) } : {}),
        title: clip(vuln.description || 'Known vulnerability'),
        package: dep.name + '@' + dep.version + ' (PyPI)',
        ...(Array.isArray(vuln.fix_versions) && vuln.fix_versions.length ? { fix: 'Upgrade ' + dep.name + ' to ' + vuln.fix_versions.slice(0, 3).join(' or ') + '.' } : {})
      });
    }
  }
  return findings;
}

export function parseSemgrep(report, workspace) {
  return (Array.isArray(report && report.results) ? report.results : []).map((item) => ({
    scanner: 'semgrep',
    severity: wordBand(item.extra && item.extra.severity),
    rule: String(item.check_id || 'semgrep'),
    title: clip(item.extra && item.extra.message),
    file: rel(workspace, item.path),
    line: item.start && item.start.line || undefined
    // item.extra.lines (the matched source) is deliberately dropped: it can contain secrets.
  }));
}

export function parseTrivy(report, workspace) {
  const findings = [];
  for (const result of Array.isArray(report && report.Results) ? report.Results : []) {
    const file = rel(workspace, result.Target);
    for (const item of Array.isArray(result.Misconfigurations) ? result.Misconfigurations : []) {
      if (item.Status && item.Status !== 'FAIL') continue;
      findings.push({ scanner: 'trivy', severity: wordBand(item.Severity), rule: String(item.ID || item.AVDID || 'misconfig'), title: clip(item.Title || item.Message), file, line: item.CauseMetadata && item.CauseMetadata.StartLine || undefined, ...(item.Resolution ? { fix: clip(item.Resolution) } : {}) });
    }
    for (const item of Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : []) {
      findings.push({ scanner: 'trivy', severity: wordBand(item.Severity), rule: String(item.VulnerabilityID), title: clip(item.Title || item.Description), package: item.PkgName + '@' + item.InstalledVersion, file, ...(item.FixedVersion ? { fix: 'Upgrade ' + item.PkgName + ' to ' + item.FixedVersion + '.' } : {}) });
    }
  }
  return findings;
}

const has = (workspace, ...names) => names.some((name) => existsSync(path.join(workspace, name)));

/** Which scanners apply to this directory, and which of those are installed. */
export function planScanners(dir, env = process.env, requested = null) {
  const git = has(dir, '.git') || existsSync(path.join(dir, '..', '.git'));
  const lockfiles = has(dir, 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'requirements.txt', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pyproject.toml', 'go.mod', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'packages.lock.json', 'pubspec.lock', 'mix.lock');
  const iac = has(dir, 'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'main.tf', 'terraform', 'k8s', 'kubernetes', 'helm', 'Chart.yaml', '.github/workflows');
  const installed = (name) => onPathSync(name, env);
  const plan = [];
  const wanted = (name) => !requested || requested.includes(name);
  if (wanted('gitleaks')) plan.push({ name: 'gitleaks', applies: true, installed: installed('gitleaks'), git });
  const osv = installed('osv-scanner');
  if (wanted('osv-scanner')) plan.push({ name: 'osv-scanner', applies: lockfiles, installed: osv });
  if (wanted('npm-audit') && (requested || !osv)) plan.push({ name: 'npm-audit', applies: has(dir, 'package-lock.json', 'npm-shrinkwrap.json'), installed: installed('npm') });
  if (wanted('pip-audit') && (requested || !osv)) plan.push({ name: 'pip-audit', applies: has(dir, 'requirements.txt', 'pyproject.toml'), installed: installed('pip-audit') });
  if (wanted('semgrep')) plan.push({ name: 'semgrep', applies: true, installed: installed('semgrep') });
  if (wanted('trivy')) plan.push({ name: 'trivy', applies: Boolean(iac || (requested && requested.includes('trivy'))), installed: installed('trivy') });
  return plan;
}

function commandFor(name, target, reportFile, options) {
  switch (name) {
    case 'gitleaks':
      return { command: 'gitleaks', args: [options.history ? 'git' : 'dir', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', reportFile, '--exit-code', '0', target] };
    case 'osv-scanner':
      return { command: 'osv-scanner', args: ['scan', 'source', '--recursive', '--format', 'json', '--output', reportFile, target] };
    case 'npm-audit':
      return { command: 'npm', args: ['audit', '--json', '--prefix', target], stdoutReport: true };
    case 'pip-audit':
      return { command: 'pip-audit', args: has(options.dir, 'requirements.txt') ? ['--format', 'json', '--output', reportFile, '--requirement', path.join(target, 'requirements.txt')] : ['--format', 'json', '--output', reportFile, target] };
    case 'semgrep': {
      const local = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find((file) => existsSync(path.join(options.dir, file)));
      return { command: 'semgrep', args: ['scan', '--config', local ? path.join(target, local) : 'p/default', '--json', '--output', reportFile, '--metrics', 'off', '--quiet', '--disable-version-check', target] };
    }
    case 'trivy':
      return { command: 'trivy', args: ['fs', '--scanners', 'misconfig,vuln', '--format', 'json', '--output', reportFile, '--quiet', target] };
    default:
      throw new Error('Unknown scanner ' + name);
  }
}

const PARSERS = { gitleaks: parseGitleaks, 'osv-scanner': parseOsv, 'npm-audit': parseNpmAudit, 'pip-audit': parsePipAudit, semgrep: parseSemgrep, trivy: parseTrivy };

// Under the OS sandbox only the workspace is writable, so reports go in a
// private folder inside .oasis; otherwise in the system temp folder.
async function reportDirectory(workspace, sandbox) {
  if (!(sandbox && sandbox.enabled && sandbox.available)) return await mkdtemp(path.join(os.tmpdir(), 'oasis-scan-'));
  const parent = path.join(await realpath(workspace), '.oasis', 'scan-reports');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('The .oasis/scan-reports folder must be a real directory, not a symlink.');
  return await mkdtemp(path.join(parent, 'scan-'));
}

export async function runSecurityScan(root, args = {}, options = {}) {
  const { runWorkspaceCommand, resolveWorkspacePath } = await import('./tools.mjs');
  const env = options.env || process.env;
  const target = await resolveWorkspacePath(root, args.path || '.');
  const workspace = target.root;
  const dir = target.absolute;
  const relTarget = (path.relative(workspace, dir) || '.').split(path.sep).join('/');
  const requested = Array.isArray(args.scanners) && args.scanners.length ? args.scanners.map(String) : null;
  if (requested) for (const name of requested) if (!PARSERS[name]) throw new Error('Unknown scanner ' + name + '. Use: ' + Object.keys(PARSERS).join(', '));
  const maxFindings = Math.max(1, Math.min(500, Number.parseInt(args.max_findings, 10) || 150));
  const plan = planScanners(dir, env, requested);
  const tmp = await reportDirectory(workspace, options.sandbox);
  const ran = [];
  const missing = [];
  let findings = [];
  try {
    for (const scanner of plan) {
      if (options.signal && options.signal.aborted) break;
      if (!scanner.applies) { if (requested) ran.push({ scanner: scanner.name, skipped: 'nothing for it to scan here' }); continue; }
      if (!scanner.installed) { missing.push({ scanner: scanner.name, install: INSTALL[scanner.name] }); continue; }
      const reportFile = path.join(tmp, scanner.name + '.json');
      const history = scanner.name === 'gitleaks' ? (args.history !== false && scanner.git) : false;
      const { command, args: argv, stdoutReport } = commandFor(scanner.name, relTarget, reportFile, { history, dir });
      const result = await runWorkspaceCommand(workspace, command, argv, {
        approval: options.approval,
        autoApprove: Boolean(options.autoApprove),
        ruleAllowed: Boolean(options.ruleAllowed),
        timeoutSeconds: 600,
        env,
        signal: options.signal,
        sandbox: options.sandbox
      });
      const entry = { scanner: scanner.name, command: [command, ...argv.map((arg) => arg.startsWith(tmp) ? '<report>' : arg)].join(' ') };
      if (scanner.name === 'gitleaks') entry.git_history = history;
      if (result.cancelled) { ran.push({ ...entry, cancelled: true }); break; }
      if (result.approved === false) { ran.push({ ...entry, skipped: result.message || 'Not approved.' }); continue; }
      let report;
      if (stdoutReport) {
        try { report = { value: JSON.parse(result.stdout || '{}') }; } catch { report = { error: 'could not read npm audit output' }; }
      } else report = await readJson(reportFile);
      if (report.value === undefined) {
        const tail = String(result.stderr || result.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-4).join(' ');
        ran.push({ ...entry, exitCode: result.exitCode, error: clip((report.tooLarge ? 'report too large' : report.error) + (tail ? ': ' + tail : ''), 400) });
        continue;
      }
      const found = PARSERS[scanner.name](report.value, workspace);
      ran.push({ ...entry, findings: found.length, ...(result.timedOut ? { timedOut: true } : {}) });
      findings.push(...found);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  findings.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || Number(Boolean(a.likely_fixture)) - Number(Boolean(b.likely_fixture)) || String(a.file || '').localeCompare(String(b.file || '')));
  const summary = { total: findings.length };
  for (const item of findings) summary[item.severity] = (summary[item.severity] || 0) + 1;
  const truncated = findings.length > maxFindings;
  if (truncated) findings = findings.slice(0, maxFindings);
  return {
    path: relTarget,
    ran,
    ...(missing.length ? { missing } : {}),
    summary,
    findings,
    ...(truncated ? { truncated: true } : {}),
    note: ran.some((item) => item.findings !== undefined)
      ? 'Scanner findings are candidates. Confirm each one in the code (is it reachable, is the secret real, does the vulnerable function get called) before reporting it. Secret values are never shown. likely_fixture marks hits in tests, examples, docs or vendored code, which are usually false positives.'
      : 'No scanner ran. ' + (missing.length ? 'Install one of the missing scanners listed above, or review the code manually.' : 'Nothing applicable was found to scan.')
  };
}
