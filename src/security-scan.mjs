// security_scan: runs the established open-source scanners that are installed
// and returns one normalized, severity-sorted list of findings.
//
//   gitleaks     secrets in files and in git history (values always redacted)
//   osv-scanner  dependencies with known vulnerabilities (OSV database)
//   npm audit    npm dependencies, when osv-scanner is missing
//   pip-audit    Python dependencies, when osv-scanner is missing
//   semgrep      risky code patterns (the project's rules, else p/default)
//   trivy        infrastructure-as-code misconfigurations and dependencies
//   govulncheck  Go vulnerabilities, reachability-aware: only code paths that
//                call the vulnerable function are findings, and osv-scanner's
//                Go results that are never called are marked not_called
//   cargo-audit  Rust crates from the RustSec database, when osv-scanner is missing
//   bandit       Python security anti-patterns (shell=True, pickle, weak hashes)
//   zizmor       GitHub Actions workflow security (template injection,
//                credential persistence, dangerous triggers, unpinned actions)
//
// Each scanner runs through runWorkspaceCommand, so the usual approval
// prompts, permission rules, the OS sandbox and cancellation apply. Reports are
// written to a private temp folder; no secret value or matched source line is
// ever returned to the model.
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import stripAnsi from 'strip-ansi';
import path from 'node:path';
import { onPathSync } from './clipboard-path.mjs';

export const SECURITY_SCAN_TOOL_DEFINITION = { type: 'function', function: {
  name: 'security_scan',
  description: 'Run the installed open-source security scanners and get one normalized list of findings: gitleaks (secrets, including git history; values are redacted), osv-scanner or npm audit / pip-audit / cargo-audit (dependencies with known CVEs), govulncheck (Go vulnerabilities whose vulnerable function is actually called), semgrep (risky code patterns), bandit (Python security issues), zizmor (GitHub Actions workflow security) and trivy (IaC misconfigurations). Reports which scanners are missing and how to install them. Use it at the start of a security review, before a release, or after adding dependencies. Findings are candidates: confirm each in the code before reporting it.',
  parameters: { type: 'object', properties: {
    scanners: { type: 'array', items: { type: 'string', enum: ['gitleaks', 'osv-scanner', 'npm-audit', 'pip-audit', 'cargo-audit', 'govulncheck', 'semgrep', 'bandit', 'zizmor', 'trivy'] }, description: 'Subset to run; default: every installed scanner that applies' },
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
  'npm-audit': 'comes with npm',
  govulncheck: 'go install golang.org/x/vuln/cmd/govulncheck@latest',
  'cargo-audit': 'cargo install cargo-audit --locked, or a release from https://github.com/rustsec/rustsec/releases',
  bandit: 'pipx install bandit',
  zizmor: 'pipx install zizmor, brew install zizmor, or cargo install zizmor --locked'
};

const RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4, info: 5 };

function cvssBand(score) {
  const value = Number.parseFloat(score);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  return value >= 9 ? 'critical' : value >= 7 ? 'high' : value >= 4 ? 'medium' : 'low';
}

// CVSS base score from a vector string (v2, v3.0, v3.1 and v4.0) through
// metaeffekt's ae-cvss-calculator. Returns null for anything it cannot score,
// which then falls back to the scanner's severity word. The calculator is
// loaded on first use so it does not slow every OASIS start.
const require = createRequire(import.meta.url);
let cvssCalculator = null;

export function cvssScore(vector) {
  cvssCalculator ||= require('ae-cvss-calculator');
  let parsed = null;
  try { parsed = cvssCalculator.fromVector(String(vector || '').trim()); } catch { return null; }
  const score = parsed ? parsed.calculateScores().base : undefined;
  return Number.isFinite(score) ? score : null;
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

// govulncheck -format json writes a stream of JSON objects, not one document.
export function parseJsonStream(text) {
  const out = [];
  const source = String(text || '');
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') { if (depth === 0) start = index; depth += 1; }
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(source.slice(start, index + 1))); } catch { /* skip a damaged object */ }
        start = -1;
      }
    }
  }
  return out;
}

// One finding per vulnerability whose vulnerable symbol is reachable from the
// module's code. Vulnerabilities in required or imported packages whose
// symbols are never called are counted (notCalled) but not reported, which is
// govulncheck's own policy and removes most dependency-scanner noise.
export function parseGovulncheck(report, workspace, base = '') {
  const messages = Array.isArray(report) ? report : [];
  const osv = new Map();
  const levels = new Map();
  const traces = new Map();
  for (const message of messages) {
    if (message.osv && message.osv.id) osv.set(message.osv.id, message.osv);
    const finding = message.finding;
    if (!finding || !finding.osv || !Array.isArray(finding.trace) || !finding.trace.length) continue;
    const head = finding.trace[0];
    const level = head.function ? 3 : head.package ? 2 : 1;
    if (level > (levels.get(finding.osv) || 0)) levels.set(finding.osv, level);
    if (level === 3 && !traces.has(finding.osv)) traces.set(finding.osv, finding);
  }
  const findings = [];
  for (const [id, finding] of traces) {
    const vuln = osv.get(id) || {};
    const head = finding.trace[0];
    const caller = finding.trace.slice(1).find((frame) => frame.position && frame.position.filename) || finding.trace[finding.trace.length - 1];
    const aliases = (vuln.aliases || []).filter((alias) => /^CVE-/.test(alias));
    const file = caller && caller.position && caller.position.filename ? rel(workspace, path.join(base, caller.position.filename)) : undefined;
    const symbol = (head.receiver ? head.receiver.replace(/^\*/, '') + '.' : '') + head.function;
    findings.push({
      scanner: 'govulncheck',
      // The Go vulnerability database has no severity scores; a vulnerable
      // function that the code really calls is treated as high.
      severity: 'high',
      rule: id,
      ...(aliases.length ? { cve: aliases.slice(0, 3) } : {}),
      title: clip(vuln.summary || vuln.details || 'Known vulnerability'),
      package: (head.module || '') + (head.version ? '@' + head.version : ''),
      called: (head.package || head.module) + '.' + symbol,
      ...(file ? { file, line: caller.position.line || undefined } : {}),
      ...(finding.fixed_version ? { fix: 'Upgrade ' + (head.module || 'the module') + ' to ' + finding.fixed_version + ' or later.' } : { fix: 'No fixed version yet; avoid calling ' + symbol + ' with untrusted input.' })
    });
  }
  const notCalled = [...levels].filter(([id, level]) => level < 3).map(([id]) => id);
  Object.defineProperty(findings, 'meta', { value: { notCalled, aliases: new Map([...osv].map(([id, v]) => [id, v.aliases || []])) } });
  return findings;
}

export function parseCargoAudit(report, workspace, base = '') {
  const findings = [];
  const lockfile = rel(workspace, path.join(base, 'Cargo.lock'));
  const vulnerabilities = report && report.vulnerabilities && Array.isArray(report.vulnerabilities.list) ? report.vulnerabilities.list : [];
  for (const item of vulnerabilities) {
    const advisory = item.advisory || {};
    const pkg = item.package || {};
    const score = cvssScore(advisory.cvss);
    const aliases = (advisory.aliases || []).filter((alias) => /^CVE-/.test(alias));
    const patched = item.versions && Array.isArray(item.versions.patched) ? item.versions.patched : [];
    const functions = advisory && item.affected && item.affected.functions ? Object.keys(item.affected.functions) : [];
    findings.push({
      scanner: 'cargo-audit',
      severity: score === null ? (advisory.informational ? 'info' : 'unknown') : cvssBand(score),
      rule: String(advisory.id || 'RUSTSEC'),
      ...(aliases.length ? { cve: aliases.slice(0, 3) } : {}),
      title: clip(advisory.title || advisory.description || 'Known vulnerability'),
      package: pkg.name + '@' + pkg.version + ' (crates.io)',
      file: lockfile,
      ...(functions.length ? { affected_functions: functions.slice(0, 5) } : {}),
      fix: patched.length ? 'Upgrade ' + pkg.name + ' to a patched version (' + patched.slice(0, 3).join(', ') + ').' : 'No patched version; consider replacing ' + pkg.name + '.'
    });
  }
  // Warnings: unmaintained, unsound, yanked and notice advisories.
  const warnings = report && report.warnings && typeof report.warnings === 'object' ? report.warnings : {};
  for (const [kind, list] of Object.entries(warnings)) {
    for (const item of Array.isArray(list) ? list : []) {
      const advisory = item.advisory || {};
      const pkg = item.package || {};
      findings.push({
        scanner: 'cargo-audit',
        severity: kind === 'unsound' ? 'medium' : 'low',
        rule: String(advisory.id || kind),
        title: clip((kind === 'yanked' ? 'Yanked crate version' : advisory.title || kind) + ' (' + kind + ')'),
        package: pkg.name + '@' + pkg.version + ' (crates.io)',
        file: lockfile,
        fix: kind === 'yanked' ? 'Update ' + pkg.name + ' to a version that has not been yanked.' : kind === 'unmaintained' ? 'Plan a replacement for ' + pkg.name + '; it no longer receives fixes.' : 'Review ' + (advisory.url || 'the advisory') + '.'
      });
    }
  }
  return findings;
}

// bandit and zizmor print paths relative to their working directory, which
// is the workspace root.
export function parseBandit(report, workspace) {
  return (Array.isArray(report && report.results) ? report.results : []).map((item) => {
    const file = rel(workspace, String(item.filename || ''));
    const severity = wordBand(item.issue_severity);
    // Low-confidence, low-severity hits are hints rather than findings.
    const confidence = String(item.issue_confidence || '').toLowerCase();
    return {
      scanner: 'bandit',
      severity: severity === 'low' && confidence === 'low' ? 'info' : severity,
      rule: String(item.test_id || 'bandit') + (item.test_name ? ' ' + item.test_name : ''),
      title: clip(item.issue_text),
      file,
      line: Number(item.line_number) || undefined,
      confidence: confidence || undefined,
      ...(item.issue_cwe && item.issue_cwe.id ? { cwe: 'CWE-' + item.issue_cwe.id } : {}),
      ...(FIXTURE_PATH.test(file) ? { likely_fixture: true } : {})
      // item.code (the matched source lines) is deliberately dropped.
    };
  });
}

export function parseZizmor(report, workspace) {
  const findings = [];
  for (const item of Array.isArray(report) ? report : []) {
    const locations = Array.isArray(item.locations) ? item.locations : [];
    const primary = locations.find((loc) => loc.symbolic && loc.symbolic.kind === 'Primary') || locations[0] || {};
    const key = primary.symbolic && primary.symbolic.key || {};
    const local = key.Local || key.local || {};
    const given = local.verbatim_path || local.given_path || local.path || '';
    const point = primary.concrete && primary.concrete.location && primary.concrete.location.start_point;
    const determinations = item.determinations || {};
    const confidence = String(determinations.confidence || '').toLowerCase();
    findings.push({
      scanner: 'zizmor',
      severity: wordBand(determinations.severity),
      rule: String(item.ident || 'zizmor'),
      title: clip((item.desc || 'Workflow issue') + (primary.symbolic && primary.symbolic.annotation ? ': ' + primary.symbolic.annotation : '')),
      ...(given ? { file: rel(workspace, given) } : {}),
      // zizmor rows are zero-based.
      ...(point && Number.isInteger(point.row) ? { line: point.row + 1 } : {}),
      confidence: confidence || undefined,
      ...(item.url ? { fix: 'See ' + item.url } : {})
    });
  }
  return findings;
}

function hasPython(dir) {
  if (has(dir, 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile')) return true;
  for (const sub of ['', 'src', 'python', 'app', 'lib']) {
    try { if (readdirSync(path.join(dir, sub)).some((name) => name.endsWith('.py'))) return true; } catch { /* missing */ }
  }
  return false;
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
  if (wanted('cargo-audit') && (requested || !osv)) plan.push({ name: 'cargo-audit', applies: has(dir, 'Cargo.lock'), installed: installed('cargo-audit') });
  // govulncheck runs alongside osv-scanner: it adds call-graph reachability.
  if (wanted('govulncheck')) plan.push({ name: 'govulncheck', applies: has(dir, 'go.mod'), installed: installed('govulncheck') });
  if (wanted('semgrep')) plan.push({ name: 'semgrep', applies: true, installed: installed('semgrep') });
  if (wanted('bandit')) plan.push({ name: 'bandit', applies: hasPython(dir), installed: installed('bandit') });
  if (wanted('zizmor')) plan.push({ name: 'zizmor', applies: has(dir, '.github/workflows', 'action.yml', 'action.yaml'), installed: installed('zizmor') });
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
    case 'govulncheck':
      return { command: 'govulncheck', args: ['-C', target, '-format', 'json', './...'], stdoutReport: 'stream' };
    case 'cargo-audit':
      return { command: 'cargo-audit', args: ['audit', '--json', '--file', path.join(target, 'Cargo.lock')], stdoutReport: true };
    case 'bandit':
      return { command: 'bandit', args: ['-r', target, '-f', 'json', '-o', reportFile, '-q', '-x', ['.git', '.venv', 'venv', 'node_modules', '.tox', '.nox', 'build', 'dist', 'site-packages'].map((name) => '*/' + name + '/*').join(',')] };
    case 'zizmor':
      return { command: 'zizmor', args: ['--format', 'json', '--no-progress', '--color', 'never', target], stdoutReport: true };
    case 'trivy':
      return { command: 'trivy', args: ['fs', '--scanners', 'misconfig,vuln', '--format', 'json', '--output', reportFile, '--quiet', target] };
    default:
      throw new Error('Unknown scanner ' + name);
  }
}

const PARSERS = { gitleaks: parseGitleaks, 'osv-scanner': parseOsv, 'npm-audit': parseNpmAudit, 'pip-audit': parsePipAudit, 'cargo-audit': parseCargoAudit, govulncheck: parseGovulncheck, semgrep: parseSemgrep, bandit: parseBandit, zizmor: parseZizmor, trivy: parseTrivy };

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
  let notCalled = null;
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
        if (stdoutReport === 'stream') {
          const messages = parseJsonStream(result.stdout);
          report = messages.length ? { value: messages } : { error: 'could not read ' + scanner.name + ' output' };
        } else {
          // An empty report is a failure (bad flag, crash), not "no findings".
          if (!String(result.stdout || '').trim()) report = { error: scanner.name + ' printed no report' };
          else { try { report = { value: JSON.parse(result.stdout) }; } catch { report = { error: 'could not read ' + scanner.name + ' output' }; } }
        }
      } else report = await readJson(reportFile);
      if (report.value === undefined) {
        const tail = stripAnsi(String(result.stderr || result.stdout || '')).trim().split('\n').slice(-4).join(' ');
        ran.push({ ...entry, exitCode: result.exitCode, error: clip((report.tooLarge ? 'report too large' : report.error) + (tail ? ': ' + tail : ''), 400) });
        continue;
      }
      const found = PARSERS[scanner.name](report.value, workspace, dir);
      const extra = {};
      if (found.meta && found.meta.notCalled) {
        extra.not_called = found.meta.notCalled.length;
        notCalled = { ids: new Set(found.meta.notCalled), aliases: found.meta.aliases };
      }
      ran.push({ ...entry, findings: found.length, ...extra, ...(result.timedOut ? { timedOut: true } : {}) });
      findings.push(...found);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  // govulncheck proved these Go vulnerabilities unreachable: keep osv-scanner's
  // entries but mark them and rank them last.
  if (notCalled) {
    const ids = new Set();
    for (const id of notCalled.ids) { ids.add(id); for (const alias of notCalled.aliases.get(id) || []) ids.add(alias); }
    for (const item of findings) {
      if (item.scanner !== 'osv-scanner' || !/\(Go\)$/.test(item.package || '')) continue;
      if (ids.has(item.rule) || (item.cve || []).some((id) => ids.has(id))) { item.not_called = true; item.severity = 'info'; }
    }
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
