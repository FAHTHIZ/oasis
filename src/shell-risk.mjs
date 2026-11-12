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

import { loadShellParser, parseShellCommands } from './shell-ast.mjs';

// Start loading the bash grammar now; analysis uses it once it is ready and
// the legacy splitter until then. run_shell awaits shellAnalyzerReady().
loadShellParser();
export const shellAnalyzerReady = () => loadShellParser();

// Splits into simple commands. Each command is { tokens, pipedFrom }, where
// pipedFrom is the previous command when joined by a single `|`.
const WINDOWS_PATH_START = /^(?:[A-Za-z]:|%[A-Za-z_]+%|\$env:[A-Za-z_]+|\\\\)/i;

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
      if (ch === '\\' && quote === '"' && i + 1 < text.length && !WINDOWS_PATH_START.test(word)) { word += text[++i]; continue; }
      word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasWord = true; continue; }
    // C:\ , C:\Users\me and $env:USERPROFILE\x are Windows paths, where a
    // backslash is a separator rather than an escape.
    if (ch === '\\' && WINDOWS_PATH_START.test(word)) { word += ch; hasWord = true; continue; }
    if (ch === '\\' && i + 1 < text.length && text[i + 1] !== '\n') { word += text[++i]; hasWord = true; continue; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { pushCommand(two); i++; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') { pushCommand(ch); continue; }
    // ${HOME}, ${HOME:?} and ${x:-y} are one parameter expansion, not a brace group.
    if (ch === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      if (end !== -1) { word += text.slice(i, end + 1); hasWord = true; i = end; continue; }
    }
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

const PREFIXES = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'time', 'nice', 'nohup', 'env', 'xargs', 'timeout', 'stdbuf', 'ionice', 'setsid', 'unbuffer', 'chronic', 'flock', 'then', 'do', 'else', '!', 'npx', 'pnpx', 'bunx', 'busybox', 'toybox', 'chrt', 'taskset', 'parallel']);
// Options of transparent prefixes that consume the next token as their value.
const PREFIX_VALUE_OPTIONS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  parallel: new Set(['-j', '--jobs', '-S', '--sshlogin', '-a', '--arg-file', '--colsep', '-d', '--delimiter', '-I', '--tmpdir', '--joblog', '--results', '-n', '--max-args', '-L', '--timeout', '--delay', '--retries', '--env', '-E']),
  xargs: new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-a', '-E', '-e', '-s', '--max-args', '--max-procs', '--delimiter', '--arg-file']),
  npx: new Set(['-p', '--package', '-c', '--call']),
  flock: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
  chrt: new Set(['-p']),
  taskset: new Set(['-c', '--cpu-list'])
};
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
      const valued = PREFIX_VALUE_OPTIONS[b];
      while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '-') {
        const opt = tokens[i];
        i++;
        if (valued && valued.has(opt) && !opt.includes('=')) i++;
      }
      if (b === 'timeout' && /^\d/.test(tokens[i] || '')) i++;
      if ((b === 'nice' || b === 'chrt') && /^-?\d+$/.test(tokens[i] || '')) i++;
      if (b === 'taskset' && /^(0x)?[0-9a-f,-]+$/i.test(tokens[i] || '') && tokens[i + 1]) i++;
      if (b === 'flock' && tokens[i] && tokens[i + 1]) i++;
      continue;
    }
    break;
  }
  return { name: base(tokens[i]), args: tokens.slice(i + 1) };
}

// Paths whose recursive deletion or ownership change is catastrophic.
// Rewrites spellings that expand to the same place: ${HOME:?}, ${HOME}, "$HOME",
// trailing /. or //, and ../ that climbs above a home or root directory.
function normalizeTarget(raw) {
  let p = String(raw).replace(/^["']|["']$/g, '');
  p = p.replace(/\$\{(HOME|USERPROFILE)(?::?[-?=+][^}]*)?\}/g, '$$$1');
  p = p.replace(/\$USERPROFILE\b/g, '$$HOME');
  p = p.replace(/^~[A-Za-z0-9._-]+(?=\/|$)/, '/home/user');
  p = p.replace(/\/{2,}/g, '/');
  for (let prev = ''; prev !== p;) { prev = p; p = p.replace(/\/\.(?=\/|$)/g, '').replace(/^\.\/(?=.)/, ''); }
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p || '/';
}

// Resolves ../ against a stand-in home so ~/.., $HOME/../.. or /usr/.. are
// judged by where they actually land.
function resolvedParent(p) {
  if (!/(^|\/)\.\.(\/|$)/.test(p) || !/^(~|\$HOME|\/)/.test(p)) return '';
  const stand = p.replace(/^(~|\$HOME)/, '/home/oasis-user');
  const parts = [];
  for (const part of stand.split('/').filter(Boolean)) {
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

function isCriticalPath(raw) {
  const p = normalizeTarget(raw);
  if (!p) return false;
  const landed = resolvedParent(p);
  if (landed) return isCriticalPath(landed.replace(/^\/home\/oasis-user(?=\/|$)/, '~') || '/');
  if (/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(\/|\\)?(\*|\.\*)?$/i.test(p)) return true;
  if (/^(\/|\/\*|\/\.\*)$/.test(p)) return true;
  if (/^\/(home|Users)\/[^/]+\/?(\*)?$/.test(p)) return true;
  if (/^\.\.(\/|\\)?(\*)?$/.test(p) || /^(\.\.(\/|\\))+\.?\.?$/.test(p)) return true;
  if (/^[A-Za-z]:(\\|\/)?(\*)?$/.test(p)) return true;
  if (/^[A-Za-z]:[\\/](Users([\\/][^\\/]+)?|Windows|Program Files( \(x86\))?|ProgramData)[\\/]?(\*)?$/i.test(p)) return true;
  if (/^(\$env:USERPROFILE|%USERPROFILE%|\$HOME|~)[\\/](Documents|Desktop|Pictures|\.ssh|AppData)[\\/]?$/i.test(p)) return true;
  if (/^\/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var|Users|Applications|Library|System)(\/\*?)?$/.test(p)) return true;
  if (/^(~|\$HOME|\$\{HOME\})\/(\.ssh|\.gnupg|\.config|Documents|Desktop|Pictures|\.aws|\.kube)\/?$/.test(p)) return true;
  return false;
}

const PRIVATE_KEY_FILE = /^(~|\$HOME|\/home\/[^/]+|\/Users\/[^/]+)\/(\.ssh\/id_[a-z0-9_]+|\.gnupg(\/(private-keys-v1\.d|secring\.gpg|pubring\.kbx))?)\/?$/;
const USER_STARTUP_FILE = /^(~|\$HOME|\/home\/[^/]+|\/Users\/[^/]+|\/root)\/(\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin|cshrc|tcshrc|kshrc|inputrc|gitconfig|npmrc|pypirc|netrc|config\/fish\/config\.fish|config\/git\/config))$/;
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
function decodesContent({ name, args }) {
  if (/^(base64|base32|basenc)$/.test(name)) return args.some((a) => a === '--decode' || /^-[a-zA-Z]*[dD]/.test(a));
  if (name === 'xxd') return args.some((a) => /^-[a-z]*r/.test(a));
  if (name === 'openssl') return args.some((a) => /^(enc|base64)$/.test(a)) && args.includes('-d');
  return /^(uudecode|gunzip|zcat|bzcat|xzcat|zstdcat|rev)$/.test(name);
}
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'fetch']);

// Words of a package-manager command after dropping options and their values.
const PM_VALUE_OPTIONS = new Set(['--registry', '--otp', '--tag', '--access', '--workspace', '-w', '--filter', '-F', '--cwd', '-C', '--prefix', '--userconfig', '--loglevel', '--scope', '--dir']);
function packageVerb(args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (PM_VALUE_OPTIONS.has(a)) i++; continue; }
    words.push(a);
    if (a !== 'npm') break;
  }
  return words;
}

function analyzeSimple(cmd, ctx = {}) {
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

  // `: > ~/.bashrc`, `> ~/.gitconfig`, `>> ~/.zshrc`: the shell startup and
  // tool config files outside the workspace. Overwriting wipes the user's
  // setup; appending is how a payload persists into every new shell.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^>+$|^>\|$|^&>>?$/.test(tokens[i]) && USER_STARTUP_FILE.test(normalizeTarget(tokens[i + 1]))) {
      return { highRisk: (tokens[i] === '>>' || tokens[i] === '&>>' ? 'appends to ' : 'overwrites ') + tokens[i + 1] + ', which runs in every new shell or tool session' };
    }
  }
  if ((name === 'truncate' || name === 'tee') && ops.some((a) => USER_STARTUP_FILE.test(normalizeTarget(a)))) {
    return { highRisk: name + ' rewrites ' + ops.find((a) => USER_STARTUP_FILE.test(normalizeTarget(a))) + ', which runs in every new shell or tool session' };
  }
  // kill -9 -1 / kill -KILL -1: signals every process the user may signal.
  // A leading -1 is a signal number (kill -1 PID sends SIGHUP); only a final
  // -1 after a signal or `--` targets every process.
  if ((name === 'kill' && args.length >= 2 && args[args.length - 1] === '-1') || name === 'killall5') {
    return { blocked: 'signals every process the user owns (kill -1), ending the session and unsaved work' };
  }
  if (name === 'rm' || name === 'remove-item' || name === 'ri' || name === 'del' || name === 'rd' || name === 'rmdir') {
    const recursive = f.short.has('r') || f.short.has('R') || f.long.has('--recursive') || lower.some((a) => a === '-recurse' || a === '/s');
    const target = ops.find(isCriticalPath);
    if (recursive && target) return { blocked: 'recursively deletes ' + target };
    if (target && (name === 'remove-item' || name === 'ri')) return { blocked: 'deletes ' + target };
    // `cd ~ && rm -rf *`: a relative target after cd into a critical directory.
    const relative = ops.find((a) => !/^[\/~$]|^[A-Za-z]:/.test(a));
    if (recursive && ctx.cwdCritical && relative) return { blocked: 'recursively deletes ' + relative + ' inside ' + ctx.cwdCritical };
    // `cd .. && rm -rf .`: OASIS does not know how deep the workspace is, so a
    // person decides whether wiping the parent folder is intended.
    if (recursive && ctx.cwdParent && ops.some((a) => /^(\.|\*|\.\*|\.\/\*?)$/.test(a))) return { highRisk: 'recursively deletes everything in ' + ctx.cwdParent + ', outside the workspace' };
  }
  if (name === 'rm' && cmd.tokens.some((t) => base(t) === 'xargs') && (f.short.has('r') || f.short.has('R') || f.long.has('--recursive'))) {
    return { highRisk: 'deletes every path fed to it through xargs, recursively' };
  }
  if (name === 'rimraf' || name === 'del-cli' || name === 'trash' || name === 'del') {
    const target = ops.find(isCriticalPath);
    if (target) return { blocked: name + ' recursively deletes ' + target };
  }
  if (name === 'rm' && (f.short.has('r') || f.short.has('R') || f.long.has('--recursive')) && ops.some((a) => /^(\.\/)?\.git\/?$/.test(normalizeTarget(a)))) {
    return { highRisk: 'deletes the .git directory, which destroys the repository history and every local branch' };
  }
  if (/^(truncate|tee|cp|install|ln|mv|rsync|sed|perl)$/.test(name)) {
    const writes = name === 'sed' || name === 'perl' ? (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) ? ops.slice(1) : []) : (name === 'tee' || name === 'truncate' ? ops : ops.slice(-1));
    const target = writes.find((a) => SYSTEM_WRITE_TARGET.test(normalizeTarget(a)));
    if (target) return { blocked: name + ' overwrites the system file ' + target };
  }
  if (name === 'rsync' && [...f.long].some((o) => o.startsWith('--delete') || o === '--remove-source-files') && ops.length >= 2 && isCriticalPath(ops[ops.length - 1])) {
    return { blocked: 'makes ' + ops[ops.length - 1] + ' match the source with rsync --delete, deleting everything else in it' };
  }
  if ((name === 'mv' || name === 'move' || name === 'move-item') && ops.length >= 2) {
    const moved = ops.slice(0, -1).find(isCriticalPath);
    if (moved) return { blocked: 'moves ' + moved + ' away, which breaks the system or the user account' };
  }
  if (name === 'rm' || name === 'unlink' || name === 'shred' || name === 'srm' || name === 'del' || name === 'remove-item' || name === 'ri') {
    const key = ops.find((a) => PRIVATE_KEY_FILE.test(normalizeTarget(a)));
    if (key) return { blocked: 'deletes the private key or keyring ' + key + ', which cannot be recovered' };
    const sys = ops.find((a) => SYSTEM_WRITE_TARGET.test(normalizeTarget(a)) && !/^(~|\$HOME)\//.test(normalizeTarget(a)));
    if (sys) return { blocked: 'deletes the system file ' + sys };
    if (ops.some((a) => /^(~|\$HOME)\/\.ssh\//.test(normalizeTarget(a)))) return { highRisk: 'deletes files in ~/.ssh (keys, known hosts, authorized keys)' };
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
  if (/^(npm|pnpm|yarn|bun)$/.test(name) && /^(npm )?publish$/.test(packageVerb(args).join(' ')) && !args.includes('--dry-run')) return { blocked: 'publishes a package to a public registry' };
  if (/^(npm|pnpm|yarn|bun)$/.test(name) && ops[0] === 'unpublish') return { blocked: 'unpublishes a package from a public registry' };
  if (name === 'poetry' && ops[0] === 'publish') return { blocked: 'publishes a Python package' };
  if ((name === 'uv' || name === 'hatch' || name === 'flit') && ops[0] === 'publish') return { blocked: 'publishes a Python package' };
  if (name === 'dotnet' && ops[0] === 'nuget' && ops[1] === 'push') return { blocked: 'publishes a NuGet package' };
  if (name === 'docker' && ops[0] === 'push') return { highRisk: 'pushes an image to a container registry' };
  if (name === 'cargo' && ops[0] === 'publish') return { blocked: 'publishes a crate to crates.io' };
  if (name === 'gem' && ops[0] === 'push') return { blocked: 'publishes a gem' };
  if (name === 'twine' && ops[0] === 'upload') return { blocked: 'publishes a Python package' };
  if (name === 'gh' && ops[0] === 'repo' && ops[1] === 'delete') return { blocked: 'deletes a remote repository' };

  if (name === 'git') {
    // Skip global options (-C dir, -c key=value, --git-dir=...) before the subcommand.
    let g = 0;
    while (g < args.length && args[g].startsWith('-')) g += (args[g] === '-C' || args[g] === '-c') ? 2 : 1;
    // `git -c alias.x='!cmd' x` runs cmd through the shell, hidden behind git.
    const globals = args.slice(0, g);
    for (let i = 0; i < globals.length; i++) {
      const setting = globals[i] === '-c' ? globals[i + 1] : globals[i].startsWith('-c') ? globals[i].slice(2) : null;
      if (typeof setting === 'string' && /^alias\.[^=]+=\s*!/i.test(setting)) return { highRisk: 'defines a git alias that runs a shell command' };
      if (/^--config-env(=|$)/.test(globals[i]) && /alias\./i.test(globals[i] + ' ' + (globals[i + 1] || ''))) return { highRisk: 'defines a git alias from an environment variable' };
    }
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
    // `git config --global core.hooksPath /tmp/x` runs that folder's scripts
    // on every Git command in every repository; sshCommand, fsmonitor,
    // credential helpers and URL rewrites have the same reach.
    if (sub === 'config' && (f.long.has('--global') || f.long.has('--system')) && !f.long.has('--get') && !f.long.has('--list') && !f.short.has('l')) {
      const key = ops[1] || '';
      if (/^(core\.(hookspath|sshcommand|fsmonitor|pager|editor|askpass)|credential\..*helper|url\..*\.(insteadof|pushinsteadof)|alias\..+|include\.path|includeif\..+)$/i.test(key) && ops.length >= 3) {
        return { highRisk: 'git config ' + (f.long.has('--system') ? '--system' : '--global') + ' ' + key + ' changes what runs for every Git command in every repository' };
      }
    }
    if (sub === 'filter-branch' || sub === 'filter-repo') return { highRisk: 'rewrites every commit in the repository history' };
    if (sub === 'reflog' && ops[1] === 'expire') return { highRisk: 'expires the reflog, removing the record used to recover lost commits' };
    if (sub === 'gc' && lower.some((a) => /^--prune(=now)?$/.test(a))) return { highRisk: 'permanently prunes unreachable commits' };
    if (sub === 'branch' && (f.short.has('D') || (f.short.has('d') && f.short.has('f')))) return { highRisk: 'force-deletes a branch' };
    if (sub === 'update-ref' && f.short.has('d')) return { highRisk: 'deletes a Git ref' };
    if (sub === 'reset' && (f.long.has('--hard') || f.long.has('--merge') || f.long.has('--keep'))) return { highRisk: 'git reset ' + [...f.long].join(' ') + ' discards uncommitted work (OASIS saves a safety snapshot under refs/oasis/safety first)' };
    if (sub === 'clean' && (f.short.has('x') || f.short.has('X'))) return { highRisk: 'git clean -x deletes ignored files (.env, local config, caches) that the safety snapshot does not keep' };
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
    // No trailing \b: it can never match after `(` and would only let a
    // one-letter table name through `truncate`.
    if (/\b(?:drop\s+(?:database|schema|table|collection)\b|truncate\s+(?:table\s+)?[\w"`.]+|delete\s+from\s+[\w"`.]+\s*;?\s*(?:["']|$)|(?:dropDatabase|deleteMany|drop)\s*\(\s*(?:\{\s*\})?\s*\)|flushall\b|flushdb\b)/i.test(sql)) {
      return { highRisk: name + ' runs a statement that drops or wipes data' };
    }
  }
  if (INTERPRETERS.has(name) && cmd.pipedFrom) {
    for (let up = cmd.pipedFrom, hops = 0; up && hops < 16; up = up.pipedFrom, hops++) {
      const source = programOf(up.tokens).name;
      if (DOWNLOADERS.has(source)) return { highRisk: 'pipes a downloaded script straight into ' + name + ' without review' };
    }
  }
  if (SHELLS.has(name) && cmd.pipedFrom && !operands(args).length) {
    const up = cmd.pipedFrom;
    const source = programOf(up.tokens);
    if (decodesContent(source)) return { highRisk: 'decodes hidden content and runs it with ' + name + ' without review' };
  }
  if ((name === 'iex' || name === 'invoke-expression') && /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|downloadstring|downloadfile|net\.webclient)\b/i.test(cmd.tokens.join(' '))) {
    return { highRisk: name + ' runs code downloaded from the network without review' };
  }
  if (name === 'set-executionpolicy' && cmd.tokens.some((t) => /^(bypass|unrestricted)$/i.test(t)) && cmd.tokens.some((t) => /^localmachine$/i.test(t))) {
    return { highRisk: 'turns off PowerShell script signing checks for every user on this machine' };
  }
  if (INTERPRETERS.has(name) && cmd.substitutions && cmd.substitutions.some((inner) => splitShell(inner).some((c) => DOWNLOADERS.has(programOf(c.tokens).name)))) {
    return { highRisk: name + ' runs a script downloaded by a command substitution without review' };
  }
  if (name === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return { blocked: 'dd writes directly to a disk device' };
  if (/^mkfs(\.|$)/.test(name) || /^(wipefs|fdisk|sfdisk|parted|diskpart|format-volume|clear-disk|initialize-disk)$/.test(name)) return { blocked: name + ' rewrites a disk or partition table' };
  return null;
}

// Finds the bodies of $(...), `...`, <(...) and >(...) outside single quotes.
// Each body is a command line the shell runs before (or alongside) the outer
// command, so it is analyzed on its own.
function extractSubstitutions(line) {
  const text = String(line || '');
  const found = [];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = ''; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && !quote) { quote = "'"; continue; }
    if (ch === '"') { quote = quote === '"' ? '' : '"'; continue; }
    if ((ch === '$' || ((ch === '<' || ch === '>') && !quote)) && text[i + 1] === '(' && text[i + 2] !== '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
      }
      found.push(text.slice(i + 2, depth ? j : j - 1));
      i = j - 1;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      found.push(text.slice(i + 1, end === -1 ? text.length : end));
      i = end === -1 ? text.length : end;
    }
  }
  return found;
}

// Credential stores whose contents should never leave the machine unnoticed.
const SENSITIVE_FILE = /(^|[\/@=<\s'"])(\.env(?!\.(example|sample|template|dist|defaults)\b)(\.[\w.-]+)?|\.ssh(\/|$|\s)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.aws\/(credentials|config)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.gnupg(\/|$|\s)|\.config\/gh\/hosts\.ya?ml|credentials\.json|service[-_]account[\w.-]*\.json|[\w.-]+\.(pem|p12|pfx|key|keystore|jks)|\/etc\/(shadow|sudoers)|\.oasis\/(config|credentials)[\w.-]*|auth\.json)($|[\s'"])/i;
const NETWORK_SENDERS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'scp', 'sftp', 'ftp', 'rsync', 'http', 'https', 'xh', 'telnet', 'openssl', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'aws', 'gsutil', 'rclone']);
const ENV_DUMPERS = new Set(['env', 'printenv', 'set', 'export', 'declare', 'get-childitem']);
const SECRET_VAR = /\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*\}?/i;

function sendsOverNetwork(name, args) {
  if (!NETWORK_SENDERS.has(name)) return false;
  if (name === 'rsync' || name === 'scp') return args.some((a) => /^[^\/\s]*[^\/\s:]:/.test(a) && !/^[A-Za-z]:\\/.test(a));
  if (name === 'aws') return args.includes('s3') && args.includes('cp');
  if (name === 'openssl') return args.includes('s_client');
  return true;
}

function readsSecrets(cmd) {
  const { name, args } = programOf(cmd.tokens);
  const first = base(cmd.tokens[0]);
  if ((ENV_DUMPERS.has(first) && cmd.tokens.slice(1).every((t) => t.startsWith('-'))) || (ENV_DUMPERS.has(name) && operands(args).length === 0)) return 'the environment (which holds API keys)';
  const hit = cmd.tokens.find((t) => SENSITIVE_FILE.test(' ' + t + ' '));
  return hit ? hit : '';
}

// Data leaving the machine: a credential file, an environment dump or a
// secret variable handed to a network command, directly or through a pipe.
function exfiltrationRisk(cmd) {
  const { name, args } = programOf(cmd.tokens);
  if (!sendsOverNetwork(name, args)) return null;
  const direct = cmd.tokens.slice(1).find((t) => SENSITIVE_FILE.test(' ' + t + ' '));
  if (direct) return { highRisk: name + ' sends ' + direct + ' over the network; credential files must not leave the machine without a person seeing it' };
  // Secret variables in a request body or URL (not an Authorization header,
  // which is how a token is normally sent to its own service).
  const BODY = /^(-d|--data(-\w+)?|-F|--form(-string)?|--post-data|--body-data|-T|--upload-file)$/;
  const secretVar = args.find((a, i) => SECRET_VAR.test(a) && (BODY.test(args[i - 1] || '') || /^(-d|-F)./.test(a) || /^https?:\/\/[^\s]*[?&=\/]\$/.test(a)));
  if (secretVar && name !== 'aws') return { highRisk: name + ' sends the secret variable in ' + secretVar.slice(0, 60) + ' to a remote host' };
  for (let up = cmd.pipedFrom, hops = 0; up && hops < 16; up = up.pipedFrom, hops++) {
    const source = readsSecrets(up);
    if (source) return { highRisk: 'pipes ' + source + ' into ' + name + ', which sends it over the network' };
  }
  return null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'busybox']);
const CODE_FLAGS = { python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], deno: ['eval'], bun: ['-e', '--eval'] };
const SSH_VALUE_OPTIONS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);

// Command lines nested inside another command: sh -c '...', eval ..., su -c,
// ssh host '...', watch '...', env -S '...', find -exec sh -c '...'.
function nestedLines(cmd) {
  const { name, args } = programOf(cmd.tokens);
  const out = [];
  if (SHELLS.has(name)) {
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (at !== -1 && args[at + 1] !== undefined) out.push(args[at + 1]);
  }
  if (name === 'eval' || name === 'watch' || name === 'iex' || name === 'invoke-expression') out.push(operands(args).join(' '));
  if (name === 'cmd' || name === 'cmd.exe') {
    const at = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (at !== -1) out.push(args.slice(at + 1).join(' '));
  }
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) {
    const at = args.findIndex((a) => /^-(c|command)$/i.test(a));
    if (at !== -1) out.push(args.slice(at + 1).join(' '));
    const enc = args.findIndex((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a));
    if (enc !== -1 && args[enc + 1]) {
      try { out.push(Buffer.from(args[enc + 1], 'base64').toString('utf16le')); } catch {}
    }
  }
  if (name === 'su') { const at = args.findIndex((a) => a === '-c' || a === '--command'); if (at !== -1 && args[at + 1]) out.push(args[at + 1]); }
  for (let i = 0; i < cmd.tokens.length - 2; i++) {
    if (base(cmd.tokens[i]) === 'env' && (cmd.tokens[i + 1] === '-S' || cmd.tokens[i + 1] === '--split-string')) out.push(cmd.tokens.slice(i + 2).join(' '));
  }
  if (name === 'ssh') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += SSH_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
    if (args.length > i + 1) out.push(args.slice(i + 1).join(' '));
  }
  if (name === 'find' || name === 'xargs') {
    for (let i = 0; i < cmd.tokens.length; i++) {
      if (SHELLS.has(base(cmd.tokens[i])) && cmd.tokens[i + 1] === '-c' && cmd.tokens[i + 2]) out.push(cmd.tokens[i + 2]);
    }
  }
  return out;
}

// Inline code for python/node/perl/ruby/php. Shell strings handed to
// system()/exec()/subprocess are analyzed as shell lines, and APIs that delete
// a home or root directory recursively are refused.
const HOME_OR_ROOT = /(expanduser\(\s*['"]~['"]\s*\)|Path\.home\(\)|os\.homedir\(\)|process\.env\.(HOME|USERPROFILE)|os\.environ(\.get\(\s*|\[\s*)['"]HOME['"]|ENV\[\s*['"]HOME['"]\s*\]|\$ENV\{\s*HOME\s*\}|getenv\(\s*['"]HOME['"]\s*\)|Dir\.home|['"](~|\/|\/home\/[^'"\/]+|\/Users\/[^'"\/]+|[A-Za-z]:\\\\?)['"])/;
const RECURSIVE_DELETE_API = /(shutil\.rmtree|rmSync|rmdirSync|fs\.rm\b|fs\.promises\.rm|rimraf|rm_rf|rm_r\b|remove_tree|rmtree|FileUtils\.rm|remove_dir_all|File\.Delete|Directory\.Delete)/;
function inlineCode(cmd) {
  const { name, args } = programOf(cmd.tokens);
  const flagsFor = CODE_FLAGS[name.replace(/[\d.]+$/, '')] || CODE_FLAGS[name];
  if (!flagsFor) return null;
  const at = args.findIndex((a) => flagsFor.includes(a));
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : null;
}

function analyzeInlineCode(code, depth) {
  if (RECURSIVE_DELETE_API.test(code) && HOME_OR_ROOT.test(code)) return { blocked: 'runs inline code that recursively deletes a home or root directory' };
  let highRisk = '';
  const literals = [...code.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  // Perl q{} qq{} qx{} and Ruby %q{} %Q{} %x{} %{} quoting.
  for (const m of code.matchAll(/(?:\bq[qxw]?|%[qQxw]?)\s*([{(\[<|\/!])/g)) {
    const open = m[1];
    const close = { '{': '}', '(': ')', '[': ']', '<': '>' }[open] || open;
    const start = m.index + m[0].length;
    const end = code.indexOf(close, start);
    if (end !== -1) literals.push(code.slice(start, end));
  }
  for (const literal of literals) {
    if (!/\s/.test(literal) || literal.length < 4) continue;
    const r = analyze(literal, depth + 1);
    if (r.blocked) return { blocked: 'runs inline code containing a shell command that ' + r.blocked };
    if (r.highRisk && !highRisk) highRisk = r.highRisk;
  }
  return highRisk ? { highRisk } : null;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
function rememberDefinitions(tokens, vars, aliases) {
  if (!tokens.length) return false;
  if (tokens.every((t) => ASSIGNMENT.test(t))) {
    for (const t of tokens) { const [, k, v] = t.match(ASSIGNMENT); vars.set(k, v); }
    return true;
  }
  if (/^(export|local|declare|typeset|readonly)$/.test(tokens[0]) && tokens.slice(1).some((t) => ASSIGNMENT.test(t)) && tokens.slice(1).every((t) => ASSIGNMENT.test(t) || t.startsWith('-'))) {
    for (const t of tokens.slice(1)) { const m = t.match(ASSIGNMENT); if (m) vars.set(m[1], m[2]); }
    return true;
  }
  if (tokens[0] === 'alias' && tokens.slice(1).some((t) => ASSIGNMENT.test(t))) {
    for (const t of tokens.slice(1)) { const m = t.match(ASSIGNMENT); if (m) aliases.set(m[1], m[2]); }
    return true;
  }
  return false;
}
function resolveIndirection(cmd, vars, aliases) {
  if (!vars.size && !aliases.size) return cmd;
  const expand = (t) => t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => (vars.has(a || b) ? vars.get(a || b) : all));
  let tokens = cmd.tokens.map(expand);
  if (aliases.has(tokens[0])) tokens = [...splitShell(aliases.get(tokens[0]))[0]?.tokens || [tokens[0]], ...tokens.slice(1)];
  // A variable holding "rm -rf" expands into several words.
  if (tokens[0] && /\s/.test(tokens[0]) && cmd.tokens[0].startsWith('$')) tokens = [...tokens[0].split(/\s+/).filter(Boolean), ...tokens.slice(1)];
  return { ...cmd, tokens };
}

const MAX_DEPTH = 6;

function analyze(line, depth) {
  if (depth > MAX_DEPTH) return { highRisk: 'nests shell commands too deeply to analyze' };
  let highRisk = '';
  // Weak reasons (a program or eval text computed at run time) only apply
  // when nothing more specific explains the risk.
  let weakRisk = '';
  const note = (r) => {
    if (!r || !r.highRisk) return;
    if (r.weak) { if (!weakRisk) weakRisk = r.highRisk; } else if (!highRisk) highRisk = r.highRisk;
  };
  const verdict = () => (highRisk ? { highRisk } : weakRisk ? { highRisk: weakRisk, weak: true } : {});
  const substitutions = extractSubstitutions(line);
  for (const inner of substitutions) {
    const r = analyze(inner, depth + 1);
    if (r.blocked) return { blocked: r.blocked + ' (inside a command substitution)' };
    note(r);
  }
  const ctx = { cwdCritical: '', cwdParent: '' };
  const vars = new Map();
  const aliases = new Map();
  const parsed = bashDialect(line) ? parseShellCommands(line) : null;
  if (parsed && (parsed.unparsable || parsed.tooLarge)) {
    // Fail closed: what the grammar cannot parse, a person reviews. The
    // legacy splitter still runs so a clear block keeps its reason.
    const legacy = analyzeCommands(splitShell(line), depth, substitutions, ctx, vars, aliases, note);
    if (legacy && legacy.blocked) return legacy;
    return { highRisk: highRisk || (parsed.tooLarge ? 'is too large to analyze reliably' : 'could not be parsed reliably as a shell command') };
  }
  const result = analyzeCommands(parsed ? parsed.commands : splitShell(line), depth, substitutions, ctx, vars, aliases, note);
  if (result && result.blocked) return result;
  return verdict();
}

// The tree-sitter grammar is bash; PowerShell and cmd lines (drive-letter
// paths, $env:, Verb-Noun cmdlets) keep the legacy splitter, which knows
// their quoting.
const NON_BASH = /(^|[\s'"=(])[A-Za-z]:\\|\$env:|(^|[\s;|&(])[A-Z][a-z]+-[A-Z][A-Za-z]+\b/;
function bashDialect(line) {
  return !NON_BASH.test(line);
}

function analyzeCommands(commands, depth, substitutions, ctx, vars, aliases, note) {
  for (const raw of commands) {
    // `x=rm; $x -rf ~` and `alias r=rm; r -rf ~`: substitute names defined
    // earlier on the same line so indirection does not hide the program.
    const cmd = resolveIndirection(raw, vars, aliases);
    cmd.substitutions = substitutions;
    if (rememberDefinitions(cmd.tokens, vars, aliases)) continue;
    const { name, args } = programOf(cmd.tokens);
    if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl' || name === 'chdir') {
      const dir = operands(args)[0];
      ctx.cwdCritical = dir === undefined || dir === '~' ? '~' : (isCriticalPath(dir) && !/^\.\./.test(dir) ? dir : '');
      ctx.cwdParent = dir !== undefined && /^\.\.(\/|\\|$)/.test(dir) ? dir : (ctx.cwdParent && dir !== undefined && !/^[\/~$]|^[A-Za-z]:/.test(dir) ? ctx.cwdParent : '');
      continue;
    }
    for (const nested of nestedLines(cmd)) {
      const r = analyze(nested, depth + 1);
      if (r.blocked) return { blocked: r.blocked + (name === 'ssh' ? ' on a remote host' : '') };
      note(r);
    }
    // `echo "rm -rf ~" | sh` / `printf '...' | bash`: the piped text is the script.
    if (SHELLS.has(name) && cmd.pipedFrom && !operands(args).length) {
      const up = programOf(cmd.pipedFrom.tokens);
      if (up.name === 'echo' || up.name === 'printf') {
        const script = operands(up.args).join(' ').replace(/\\n/g, '\n');
        const r = analyze(script, depth + 1);
        if (r.blocked) return { blocked: r.blocked + ' (in text piped into ' + name + ')' };
        note(r);
      }
    }
    // `bash <<< 'rm -rf ~'`, `sh <<'EOF' ... EOF`, `python3 <<EOF`: the
    // here-string or heredoc is the script.
    if (cmd.stdinScript && !operands(args).some((a) => a !== '<<<' && a !== cmd.stdinScript)) {
      if (SHELLS.has(name)) {
        const r = analyze(cmd.stdinScript, depth + 1);
        if (r.blocked) return { blocked: r.blocked + ' (in a script fed to ' + name + ')' };
        note(r);
      } else if (CODE_FLAGS[name.replace(/[0-9.]+$/, '')] || CODE_FLAGS[name]) {
        const r = analyzeInlineCode(cmd.stdinScript, depth);
        if (r && r.blocked) return r;
        note(r);
      }
    }
    if (cmd.computedName) note({ highRisk: 'runs a program whose name is computed by another command at run time', weak: true });
    if (cmd.ast && name === 'eval' && args.some((a) => /\$\(|`|\$\{?[A-Za-z_]/.test(a))) note({ highRisk: 'evaluates shell text that is only known at run time', weak: true });
    const code = inlineCode(cmd);
    if (code) {
      const r = analyzeInlineCode(code, depth);
      if (r && r.blocked) return r;
      note(r);
    }
    note(exfiltrationRisk(cmd));
    const result = analyzeSimple(cmd, ctx);
    if (!result) continue;
    if (result.blocked) return { blocked: result.blocked };
    note(result);
  }
  return null;
}

// Returns { blocked?: string, highRisk?: string } for the whole shell line.
export function analyzeShellLine(line) {
  const result = analyze(String(line || ''), 0);
  return result.weak ? { highRisk: result.highRisk } : result;
}
