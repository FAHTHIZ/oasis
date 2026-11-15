// Static audit of a skill package before it is installed. Nothing is run:
// every regular text file in the package is read and matched line by line
// against a short list of patterns that signal a script or instruction worth
// a human look (piping a download into a shell, reading private keys, hiding
// actions from the user, invisible Unicode that changes how text reads).
//
// Severity:
//   high   - blocks the install unless the user explicitly allows it
//            (`--allow-risky` on the CLI, allow_risky on the agent tool).
//   medium - reported with the install result; the install goes ahead.
//
// A regex audit is a tripwire, not a sandbox: a determined author can evade
// it, and installed skills stay untrusted instructions with no permissions of
// their own. The idea follows Hermes Agent's skills guard (MIT); the rules
// and code here are OASIS's own.

import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FINDINGS = 100;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

// Shells and interpreters a downloaded script is commonly piped into.
const SHELLS = String.raw`(?:sudo\s+)?(?:ba|z|k|da|fi)?sh\b|python[0-9.]*\b|node\b|perl\b|ruby\b|php\b|pwsh\b|powershell\b|iex\b|Invoke-Expression\b`;

export const SKILL_AUDIT_RULES = [
  // high
  { id: 'reverse-shell', severity: 'high', pattern: /\/dev\/tcp\/|\bnc(?:at)?\s+(?:-\w+\s+)*-e\s|\bsocat\b[^\n]*\bexec:|\bbash\s+-i\s+>&/i, description: 'Opens a reverse shell or binds a shell to the network' },
  { id: 'encoded-exec', severity: 'high', pattern: new RegExp(String.raw`base64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:` + SHELLS + ')|FromBase64String\\([^\\n]*\\)[^\\n]*(?:iex|Invoke-Expression)|\\beval\\s*\\(\\s*(?:atob|Buffer\\.from)\\(', 'i'), description: 'Decodes hidden content and runs it' },
  { id: 'private-key-read', severity: 'high', pattern: /~\/\.ssh\/id_|\$HOME\/\.ssh\/id_|\.ssh[\\/]+id_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws[\\/]+credentials\b|\.netrc\b|\.docker[\\/]+config\.json|\bsecurity\s+find-(?:generic|internet)-password\b|\.config[\\/]+gh[\\/]+hosts\.yml/i, description: 'Reads private keys or stored credentials' },
  { id: 'env-exfiltration', severity: 'high', pattern: /\b(?:env|printenv|set)\s*\|\s*(?:curl|wget|nc|ncat)\b|\b(?:curl|wget)\b[^\n]*(?:\$\(\s*(?:env|printenv)\s*\)|`(?:env|printenv)`|(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\s+["']?[\w=]*@["']?(?:~|\$HOME)?[\w./-]*(?:\.env\b|\.ssh\b|\.aws\b|credentials\b))|JSON\.stringify\(\s*process\.env\s*\)|os\.environ\.copy\(\)[^\n]*(?:post|send)|\bdict\(\s*os\.environ\s*\)[^\n]*(?:post|send)/i, description: 'Sends the environment or secret files over the network' },
  { id: 'destructive-delete', severity: 'high', pattern: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\/\*|~\/\*)(?:\s|$|["'])/i, description: 'Deletes the root or home folder' },
  { id: 'hide-from-user', severity: 'high', pattern: /\b(?:do not|don't|never)\s+(?:tell|inform|show|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to)\s+the\s+user\b(?!\s+to\b)|\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b|(?<!["'`\u201C])\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions|rules)\b|(?<!["'`\u201C])\bdisregard\s+(?:the\s+)?(?:system|previous)\s+(?:prompt|instructions)\b/i, description: 'Tells the agent to hide actions from the user or override its instructions' },
  { id: 'bidi-control', severity: 'high', pattern: /[\u202A-\u202E\u2066-\u2069]/, description: 'Contains Unicode direction controls that can make text read differently than it runs' },
  { id: 'agent-config-tamper', severity: 'high', pattern: /(?:>>?|\btee\b(?:\s+-a)?|\bsed\s+-i\b|\bwrite(?:FileSync)?\b|\bappend)[^\n]*(?:\.oasis[\\/]+settings(?:\.local)?\.json|\.claude[\\/]+settings(?:\.local)?\.json|\.oasis[\\/]+hooks|trustedWorkspaces|defaultMode["']?\s*:\s*["']bypassPermissions)/i, description: 'Changes OASIS or Claude Code permissions, hooks or trust settings' },
  // medium
  { id: 'pipe-to-shell', severity: 'medium', pattern: new RegExp(String.raw`\b(?:curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^\n|]*\|\s*(?:` + SHELLS + ')', 'i'), description: 'Pipes a download straight into a shell or interpreter' },
  { id: 'privilege', severity: 'medium', pattern: /(?:^|[\s;&|`(])sudo\s+\S|\bchmod\s+(?:[0-7]*7[0-7]{2}\b|[ugoa]*\+s\b|-R\s+777\b)|\bchown\s+-R\s+root\b/i, description: 'Runs as root or widens file permissions' },
  { id: 'persistence', severity: 'medium', pattern: /(?:>>?|\btee\b(?:\s+-a)?)\s*["']?(?:~|\$HOME)\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b|\|\s*crontab\s+-(?:\s|$)|\bcrontab\s+-e\b|LaunchAgents[\\/]|\bsystemctl\s+(?:--user\s+)?enable\b|\bschtasks(?:\.exe)?\s+\/create\b|CurrentVersion\\+Run\b/i, description: 'Makes something start automatically (shell profile, cron, launchd, systemd, scheduled task)' },
  { id: 'global-install', severity: 'medium', pattern: /\bnpm\s+(?:install|i)\s+(?:-g|--global)\b|\bpip3?\s+install\b[^\n]*--break-system-packages|\bcargo\s+install\b|\bgo\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b/i, description: 'Installs software on the machine' },
  { id: 'zero-width', severity: 'medium', pattern: /[\u200B-\u200D\u2060\uFEFF]/, description: 'Contains invisible zero-width characters' }
];

const BINARY_MAGIC = [
  { bytes: [0x7f, 0x45, 0x4c, 0x46], kind: 'ELF executable' },
  { bytes: [0x4d, 0x5a], kind: 'Windows executable' },
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], kind: 'Mach-O executable' },
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], kind: 'Mach-O executable' },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], kind: 'Mach-O universal binary' }
];

function binaryKind(buffer) {
  for (const { bytes, kind } of BINARY_MAGIC) if (buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value)) return kind;
  return '';
}

const clip = (text) => {
  const line = String(text).replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).trim();
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
};

/** Audit one file's text. Returns findings with 1-based line numbers. */
export function auditSkillText(text, file = 'SKILL.md') {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  const prose = /\.(?:md|markdown|txt|rst)$/i.test(file);
  for (let index = 0; index < lines.length && findings.length < MAX_FINDINGS; index++) {
    const line = lines[index];
    // The first character of a file may be a byte-order mark.
    const probe = index === 0 ? line.replace(/^\uFEFF/, '') : line;
    for (const rule of SKILL_AUDIT_RULES) {
      if (!rule.pattern.test(probe)) continue;
      // A path named in prose is not a read: the agent's own permission rules
      // still refuse secret files. In a script it runs with the user's rights.
      const severity = rule.id === 'private-key-read' && prose ? 'medium' : rule.severity;
      findings.push({ rule: rule.id, severity, description: rule.description, file, line: index + 1, excerpt: clip(probe) });
    }
  }
  return findings;
}

/**
 * Audit every regular file under a skill folder without following symlinks.
 * Returns { findings, files, high, medium, blocked }.
 */
export async function auditSkillDirectory(directory) {
  const findings = [];
  let files = 0;
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (findings.length >= MAX_FINDINGS) return;
      const full = path.join(current, entry.name);
      const info = await lstat(full).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(full); continue; }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      files++;
      const relative = path.relative(directory, full).split(path.sep).join('/');
      const buffer = await readFile(full).catch(() => null);
      if (!buffer) continue;
      const binary = binaryKind(buffer);
      if (binary) { findings.push({ rule: 'executable-binary', severity: 'medium', description: 'Ships a compiled program (' + binary + ')', file: relative, line: 0, excerpt: '' }); continue; }
      if (buffer.includes(0)) continue; // other binary data (images, fonts)
      findings.push(...auditSkillText(buffer.toString('utf8'), relative));
    }
  }
  await walk(directory);
  const kept = findings.slice(0, MAX_FINDINGS);
  const high = kept.filter((item) => item.severity === 'high').length;
  return { findings: kept, files, high, medium: kept.length - high, blocked: high > 0 };
}

/** Short human-readable report, one line per finding. */
export function formatSkillAudit(name, audit, { limit = 12 } = {}) {
  if (!audit || !audit.findings.length) return '';
  const lines = audit.findings.slice(0, limit).map((item) => '  [' + item.severity + '] ' + item.file + (item.line ? ':' + item.line : '') + ' ' + item.description + (item.excerpt ? ': ' + item.excerpt : ''));
  if (audit.findings.length > limit) lines.push('  ... and ' + (audit.findings.length - limit) + ' more');
  return 'Audit of ' + name + ': ' + audit.high + ' high, ' + audit.medium + ' medium\n' + lines.join('\n');
}
