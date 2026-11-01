// Shell-line risk analysis for run_shell / powershell.
//
// run_command already inspects an executable and its argv. A shell line is
// harder: one string can chain several programs, quote paths, and pipe a
// download into an interpreter. This module splits a line into simple
// commands (respecting quotes), tokenizes each, and classifies it:
//
//   blocked  -> never runs, regardless of approvals or permission mode.
//               Reserved for commands whose damage is catastrophic and not
//               recoverable from the workspace: wiping /, ~ or a parent
//               directory, rewriting disks, publishing packages, deleting a
//               remote repository, force-pushing over history.
//   highRisk -> runs only after a person approves it in that moment. Auto
//               approve, allow rules, sandbox auto-allow and bypass mode do
//               not cover it. Used for commands that are sometimes intended
//               but destroy shared or remote state when they are not.
//
// Everything else falls through to the normal approval policy.

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n']);

// Splits into simple commands. Each command is { tokens, pipedFrom }, where
// pipedFrom is the previous command when joined by a single `|`.
export function splitShell(line) {
  const commands = [];
  let tokens = [];
  let word = '';
  let hasWord = false;
  let quote = '';
  let joinedByPipe = false;
  const pushWord = () => { if (hasWord) tokens.push(word); word = ''; hasWord = false; };
  const pushCommand = (sep) => {
    pushWord();
    if (tokens.length) commands.push({ tokens, pipedFrom: joinedByPipe ? commands[commands.length - 1] || null : null });
    tokens = [];
    joinedByPipe = sep === '|';
  };
  const text = String(line || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { word += text[++i]; continue; }
      word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasWord = true; continue; }
    if (ch === '\\' && i + 1 < text.length && text[i + 1] !== '\n') { word += text[++i]; hasWord = true; continue; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { pushCommand(two); i++; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') { pushCommand(ch); continue; }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '`') { pushWord(); continue; }
    if (ch === '>' || ch === '<') {
      pushWord();
      let op = ch;
      while (text[i + 1] === '>' || text[i + 1] === '&' || text[i + 1] === '|') op += text[++i];
      tokens.push(op);
      continue;
    }
    if (/\s/.test(ch)) { pushWord(); continue; }
    word += ch;
    hasWord = true;
  }
  pushCommand('');
  return commands;
}

const PREFIXES = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'time', 'nice', 'nohup', 'env', 'xargs', 'timeout', 'stdbuf', 'ionice', 'then', 'do', 'else', '!']);
const base = (token) => String(token || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();

// Returns the program name and its arguments, skipping env assignments and
// transparent prefixes such as sudo, env, nohup and timeout 10.
export function programOf(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    const b = base(t);
    if (PREFIXES.has(b)) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      if (b === 'timeout' && /^\d/.test(tokens[i] || '')) i++;
      continue;
    }
    break;
  }
  return { name: base(tokens[i]), args: tokens.slice(i + 1) };
}

// Paths whose recursive deletion or ownership change is catastrophic.
function isCriticalPath(raw) {
  const p = String(raw).replace(/^["']|["']$/g, '');
  if (!p) return false;
  if (/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(\/|\\)?(\*|\.\*)?$/i.test(p)) return true;
  if (/^(\/|\/\*|\/\.\*)$/.test(p)) return true;
  if (/^\/(home|Users)\/[^/]+\/?(\*)?$/.test(p)) return true;
  if (/^\.\.(\/|\\)?(\*)?$/.test(p) || /^(\.\.(\/|\\))+\.?\.?$/.test(p)) return true;
  if (/^[A-Za-z]:(\\|\/)?(\*)?$/.test(p)) return true;
  if (/^\/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var|Users|Applications|Library|System)(\/\*?)?$/.test(p)) return true;
  if (/^(~|\$HOME|\$\{HOME\})\/(\.ssh|\.gnupg|\.config|Documents|Desktop|Pictures|\.aws|\.kube)\/?$/.test(p)) return true;
  return false;
}

const SYSTEM_WRITE_TARGET = /^(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/|\/lib\/|\/dev\/(sd|hd|nvme|disk|mmcblk|xvd)|\/System\/|(~|\$HOME)\/\.ssh\/)/;

function flags(args) {
  const short = new Set();
  const long = new Set();
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('--')) long.add(a.split('=')[0]);
    else if (a.startsWith('-') && a.length > 1) for (const ch of a.slice(1)) short.add(ch);
  }
  return { short, long };
}

const operands = (args) => {
  const out = [];
  let end = false;
  for (const a of args) {
    if (!end && a === '--') { end = true; continue; }
    if (!end && a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
};

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'iex', 'invoke-expression', 'pwsh', 'powershell']);
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'fetch']);

function analyzeSimple(cmd) {
  const { tokens } = cmd;
  const { name, args } = programOf(tokens);
  if (!name) return null;
  const lower = args.map((a) => a.toLowerCase());
  const f = flags(args);
  const ops = operands(args);

  // Output redirection over a system file (works for any program, including `: >`).
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^>+$|^>\|$|^&>$/.test(tokens[i]) && SYSTEM_WRITE_TARGET.test(tokens[i + 1])) {
      return { blocked: 'redirects output over the system file ' + tokens[i + 1] };
    }
  }

  if (name === 'rm' || name === 'remove-item' || name === 'ri' || name === 'del' || name === 'rd' || name === 'rmdir') {
    const recursive = f.short.has('r') || f.short.has('R') || f.long.has('--recursive') || lower.some((a) => a === '-recurse' || a === '/s');
    const target = ops.find(isCriticalPath);
    if (recursive && target) return { blocked: 'recursively deletes ' + target };
    if (target && (name === 'remove-item' || name === 'ri')) return { blocked: 'deletes ' + target };
  }
  if (name === 'rm' && cmd.tokens.some((t) => base(t) === 'xargs') && (f.short.has('r') || f.short.has('R') || f.long.has('--recursive'))) {
    return { highRisk: 'deletes every path fed to it through xargs, recursively' };
  }
  if (name === 'shred' || name === 'srm') return { highRisk: name + ' destroys files beyond recovery' };
  if ((name === 'mv' || name === 'move' || name === 'move-item') && ops.length >= 2 && /^\/dev\/null$|^nul$/i.test(ops[ops.length - 1])) {
    return { blocked: 'moves files onto ' + ops[ops.length - 1] + ', which destroys them' };
  }
  if (name === 'crontab' && f.short.has('r')) return { highRisk: 'crontab -r deletes every scheduled job for the user' };
  if (name === 'find') {
    const start = ops[0];
    const deletes = args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir') && /^(rm|shred|unlink)$/.test(base(args[i + 1])));
    if (deletes && start && isCriticalPath(start)) return { blocked: 'find deletes files under ' + start };
  }
  if ((name === 'chmod' || name === 'chown' || name === 'chgrp') && (f.short.has('R') || f.long.has('--recursive'))) {
    const target = ops.slice(1).find(isCriticalPath);
    if (target) return { blocked: name + ' -R changes permissions on ' + target };
  }
  if (/^(shutdown|reboot|poweroff|halt)$/.test(name) || (name === 'systemctl' && /^(poweroff|reboot|halt|kexec)$/.test(lower[0] || ''))) {
    return { blocked: 'shuts down or restarts the machine' };
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(name) && (ops[0] === 'publish' || (ops[0] === 'npm' && ops[1] === 'publish'))) return { blocked: 'publishes a package to a public registry' };
  if (name === 'cargo' && ops[0] === 'publish') return { blocked: 'publishes a crate to crates.io' };
  if (name === 'gem' && ops[0] === 'push') return { blocked: 'publishes a gem' };
  if (name === 'twine' && ops[0] === 'upload') return { blocked: 'publishes a Python package' };
  if (name === 'gh' && ops[0] === 'repo' && ops[1] === 'delete') return { blocked: 'deletes a remote repository' };

  if (name === 'git') {
    // Skip global options (-C dir, -c key=value, --git-dir=...) before the subcommand.
    let g = 0;
    while (g < args.length && args[g].startsWith('-')) g += (args[g] === '-C' || args[g] === '-c') ? 2 : 1;
    const gitArgs = args.slice(g);
    return analyzeGit(gitArgs, flags(gitArgs), operands(gitArgs));
  }
  return analyzeOther(name, args, lower, f, ops, cmd);
}

function analyzeGit(args, f, ops) {
  const lower = args.map((a) => a.toLowerCase());
  {
    const sub = ops[0];
    if (sub === 'push') {
      if (f.long.has('--force') || f.long.has('--force-with-lease') || f.long.has('--force-if-includes') || f.short.has('f') || f.long.has('--mirror')) {
        return { blocked: 'force-pushes over remote history' };
      }
      if (ops.slice(1).some((a) => /^\+/.test(a) || /(^|:)\+/.test(a))) return { blocked: 'force-pushes a refspec (+ref) over remote history' };
      if (f.long.has('--delete') || ops.slice(1).some((a) => /^:[^:]/.test(a))) return { highRisk: 'deletes a remote branch or tag' };
    }
    if (sub === 'filter-branch' || sub === 'filter-repo') return { highRisk: 'rewrites every commit in the repository history' };
    if (sub === 'reflog' && ops[1] === 'expire') return { highRisk: 'expires the reflog, removing the record used to recover lost commits' };
    if (sub === 'gc' && lower.some((a) => /^--prune(=now)?$/.test(a))) return { highRisk: 'permanently prunes unreachable commits' };
    if (sub === 'branch' && (f.short.has('D') || (f.short.has('d') && f.short.has('f')))) return { highRisk: 'force-deletes a branch' };
    if (sub === 'update-ref' && f.short.has('d')) return { highRisk: 'deletes a Git ref' };
  }
  return null;
}

function analyzeOther(name, args, lower, f, ops, cmd) {
  if (name === 'gh' && ((ops[0] === 'release' && ops[1] === 'delete') || (ops[0] === 'secret' && ops[1] === 'delete') || (ops[0] === 'api' && lower.some((a, i) => (a === '-x' || a === '--method') && /^delete$/i.test(args[i + 1] || ''))))) {
    return { highRisk: 'deletes GitHub resources' };
  }
  if (/^(docker|podman|nerdctl)$/.test(name)) {
    const words = ops;
    if ((words[0] === 'system' && words[1] === 'prune') || (words[0] === 'volume' && /^(rm|prune)$/.test(words[1] || '')) || (/^(image|container|network|builder)$/.test(words[0] || '') && words[1] === 'prune')) {
      return { highRisk: name + ' deletes containers, images or volumes (and their data)' };
    }
    if (words[0] === 'compose' && words.includes('down') && (f.short.has('v') || f.long.has('--volumes'))) return { highRisk: 'docker compose down -v deletes volumes and their data' };
  }
  if (name === 'kubectl' && /^(delete|drain|replace|scale)$/.test(ops[0] || '')) return { highRisk: 'kubectl ' + ops[0] + ' changes live cluster resources' };
  if (name === 'helm' && /^(uninstall|delete|rollback)$/.test(ops[0] || '')) return { highRisk: 'helm ' + ops[0] + ' changes a live release' };
  if (name === 'terraform' || name === 'tofu') {
    if (ops[0] === 'destroy' || (ops[0] === 'apply' && (lower.includes('-destroy') || lower.includes('-auto-approve')))) return { highRisk: name + ' changes or destroys real infrastructure' };
  }
  if (/^(aws|gcloud|az)$/.test(name) && lower.some((a) => /^(delete|rm|rb|remove|terminate-instances|delete-bucket|delete-stack|delete-db-instance)$/.test(a))) {
    return { highRisk: name + ' deletes cloud resources' };
  }
  if (/^(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|redis-cli)$/.test(name)) {
    const sql = args.join(' ');
    if (/\b(drop\s+(database|schema|table)|truncate\s+(table\s+)?\w|delete\s+from\s+\w+\s*;?\s*$|dropDatabase\s*\(|flushall|flushdb)\b/i.test(sql)) {
      return { highRisk: name + ' runs a statement that drops or wipes data' };
    }
  }
  if (INTERPRETERS.has(name) && cmd.pipedFrom) {
    const source = programOf(cmd.pipedFrom.tokens).name;
    if (DOWNLOADERS.has(source)) return { highRisk: 'pipes a downloaded script straight into ' + name + ' without review' };
  }
  if (name === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return { blocked: 'dd writes directly to a disk device' };
  if (/^mkfs(\.|$)/.test(name) || /^(wipefs|fdisk|sfdisk|parted|diskpart|format-volume|clear-disk|initialize-disk)$/.test(name)) return { blocked: name + ' rewrites a disk or partition table' };
  return null;
}

// Returns { blocked?: string, highRisk?: string } for the whole shell line.
export function analyzeShellLine(line) {
  let highRisk = '';
  for (const cmd of splitShell(line)) {
    const result = analyzeSimple(cmd);
    if (!result) continue;
    if (result.blocked) return { blocked: result.blocked };
    if (result.highRisk && !highRisk) highRisk = result.highRisk;
  }
  return highRisk ? { highRisk } : {};
}
