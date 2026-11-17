// What a shell command does, in the words a person would use: `cat a.js`
// reads a file, `rg TODO src` searches, `ls src` lists a folder. Codex's
// "Explored · Read a.js, Search TODO" and Claude Code's collapsed "Read 2
// files" read commands this way. A command that writes, moves or deletes
// anything is never called a read or a search, even when it starts with one
// (`cat a > b`, `find . -delete`, `sort -o`, `sed -i`): Claude Code 2.1.326
// fixed exactly that, and a feed that says "Read" for a write is worse than
// one that says "Ran a command".
//
// commandIntent(command) → { kind, targets }
//   kind: 'read' | 'search' | 'list' | 'run'
//   targets: files read, patterns searched or folders listed (at most 4)
// Pure and synchronous; shared by the live view and restored chats.

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl', 'wc', 'file', 'stat', 'xxd', 'od', 'hexdump', 'strings', 'jq', 'yq', 'readlink', 'realpath', 'md5sum', 'sha256sum', 'sha1sum', 'diff', 'cmp']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'fdfind', 'locate', 'which', 'whereis']);
const LISTERS = new Set(['ls', 'll', 'tree', 'du', 'pwd', 'exa', 'eza']);
// Commands that only shape what an earlier stage printed.
const FILTERS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'wc', 'cut', 'tr', 'awk', 'sed', 'column', 'less', 'more', 'cat', 'nl', 'jq', 'xargs']);
// Words that make a command change things, wherever they appear.
const FIND_CHANGES = /(^|\s)(-delete|-exec|-execdir|-ok|-okdir|-fprint\S*|-fls)(\s|$)/;
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'tee', 'dd', 'truncate', 'install', 'patch', 'unlink', 'shred']);

// Splits "a && b; c || d" into statements and each into pipe stages, keeping
// quoted text whole. Returns null for anything too clever to read safely
// (subshells, command substitution, heredocs, backgrounding).
function parse(command) {
  const text = String(command || '').trim();
  if (!text || text.length > 2000) return null;
  if (/\$\(|`|<<|\(\s|^\(|\{\s/.test(text)) return null;
  const statements = [];
  let stages = [];
  let words = [];
  let word = '';
  let quote = '';
  let redirect = false;
  const endWord = () => { if (word) { words.push(word); word = ''; } };
  const endStage = () => { endWord(); if (words.length) stages.push({ words, redirect }); words = []; redirect = false; };
  const endStatement = () => { endStage(); if (stages.length) statements.push(stages); stages = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\' && i + 1 < text.length) { word += text[++i]; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '\n') { endStatement(); continue; }
    if (ch === ';') { endStatement(); continue; }
    if (ch === '&') {
      if (text[i + 1] === '&') { i++; endStatement(); continue; }
      // 2>&1 and >&2 are fine; a lone & backgrounds the command.
      if (text[i - 1] === '>' || text[i + 1] === '>') { word += ch; continue; }
      return null;
    }
    if (ch === '|') {
      if (text[i + 1] === '|') { i++; endStatement(); continue; }
      endStage();
      continue;
    }
    if (ch === '>' || ch === '<') {
      // Where output goes: a file is a write; /dev/null and 2>&1 are not.
      endWord();
      let j = i + 1;
      while (text[j] === '>' || text[j] === '&') j++;
      while (text[j] === ' ') j++;
      let k = j;
      while (k < text.length && !/[\s;|&]/.test(text[k])) k++;
      const target = text.slice(j, k);
      if (ch === '>' && !/^(\/dev\/null|\d)$/.test(target) && !(words.length && /^\d$/.test(words.at(-1)) && /^\d$/.test(target))) redirect = true;
      if (words.length && /^\d$/.test(words.at(-1))) words.pop();
      i = k - 1;
      continue;
    }
    word += ch;
  }
  if (quote) return null;
  endStatement();
  return statements;
}

const base = (word) => String(word || '').split('/').filter(Boolean).at(-1) || String(word || '');
const operands = (words) => words.slice(1).filter((word) => word && !word.startsWith('-'));

// One stage: what it is and what it names. Options that take a value are
// skipped so `head -n 20 a.js` reads a.js, not "20".
const VALUE_FLAGS = { head: /^-[nc]$/, tail: /^-[nc]$/, grep: /^-[efABCm]$|^--(regexp|file|max-count|context|after-context|before-context)$/, rg: /^-[egtTABCmM]$|^--(regexp|glob|type|type-not|max-count|context|after-context|before-context|max-columns)$/, sed: /^-[ef]$/, find: /^-(name|iname|path|ipath|type|maxdepth|mindepth|newer|size|mtime|regex|iregex|user|group|perm)$/, fd: /^-[etdE]$|^--(extension|type|max-depth|exclude)$/, du: /^-d$|^--max-depth$/, tree: /^-[LIP]$/, wc: /^$/ };
function stageIntent(stage) {
  const words = stage.words;
  let at = 0;
  // env VAR=1 cmd, sudo cmd, command cmd, time cmd
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || ['env', 'command', 'time', 'nice', 'nohup'].includes(words[at]))) at++;
  const rest = words.slice(at);
  const name = base(rest[0] || '');
  if (!name) return { kind: 'none', targets: [] };
  if (WRITERS.has(name) || stage.redirect) return { kind: 'run', targets: [] };
  const joined = ' ' + rest.slice(1).join(' ') + ' ';
  const pick = (skip) => {
    const out = [];
    for (let i = 1; i < rest.length; i++) {
      const word = rest[i];
      if (skip && skip.test(word)) { i++; continue; }
      if (word.startsWith('-')) continue;
      out.push(word);
    }
    return out;
  };
  if (name === 'git') {
    const sub = rest[1];
    if (sub === 'grep') return { kind: 'search', targets: operands(rest.slice(1)).slice(0, 1) };
    if (sub === 'ls-files') return { kind: 'list', targets: [] };
    if (sub === 'show' && /:/.test(rest[2] || '')) return { kind: 'read', targets: [String(rest[2]).split(':').at(-1)] };
    return { kind: 'run', targets: [] };
  }
  if (name === 'sed') {
    if (/(^|\s)(-i\S*|--in-place\S*|-[a-z]*i[a-z]*)(\s|$)/.test(joined)) return { kind: 'run', targets: [] };
    const scripted = /(^|\s)(-e|-f)\s/.test(joined);
    return { kind: 'read', targets: pick(VALUE_FLAGS.sed).slice(scripted ? 0 : 1) };
  }
  if (name === 'awk') return { kind: 'read', targets: pick().slice(1) };
  if (name === 'find') {
    if (FIND_CHANGES.test(joined)) return { kind: 'run', targets: [] };
    const named = /(^|\s)-i?(name|path|regex)\s+(\S+)/.exec(joined);
    if (named) return { kind: 'search', targets: [named[3]] };
    const dirs = pick(VALUE_FLAGS.find).filter((word) => !word.startsWith('('));
    return { kind: 'list', targets: dirs.slice(0, 1) };
  }
  if (name === 'sort') return /(^|\s)(-o|--output)/.test(joined) ? { kind: 'run', targets: [] } : { kind: 'read', targets: pick() };
  if (READERS.has(name)) return { kind: 'read', targets: pick(VALUE_FLAGS[name]) };
  if (SEARCHERS.has(name)) {
    if (name === 'rg' && /(^|\s)--files(\s|$)/.test(joined)) return { kind: 'list', targets: [] };
    const words = pick(VALUE_FLAGS[name]);
    const flagged = /(^|\s)(-e|--regexp)\s+(\S+)/.exec(joined);
    return { kind: 'search', targets: [flagged ? flagged[3] : words[0]].filter(Boolean) };
  }
  if (LISTERS.has(name)) return { kind: 'list', targets: pick(VALUE_FLAGS[name]).slice(0, 1) };
  if (name === 'cd') return { kind: 'none', targets: [] };
  if (name === 'echo' || name === 'printf' || name === 'true') return { kind: 'none', targets: [] };
  return { kind: 'run', targets: [] };
}

export function commandIntent(command) {
  const statements = parse(command);
  if (!statements) return { kind: 'run', targets: [] };
  const kinds = [];
  const targets = { read: [], search: [], list: [] };
  for (const stages of statements) {
    const first = stageIntent(stages[0]);
    if (first.kind === 'run') return { kind: 'run', targets: [] };
    // Later stages may only filter what the first printed.
    for (const stage of stages.slice(1)) {
      const name = base(stage.words[0] || '');
      if (stage.redirect || !FILTERS.has(name)) return { kind: 'run', targets: [] };
      if (name === 'xargs') {
        const inner = stageIntent({ words: stage.words.slice(1), redirect: false });
        if (inner.kind === 'run' || inner.kind === 'none') return { kind: 'run', targets: [] };
      } else if (stageIntent(stage).kind === 'run') return { kind: 'run', targets: [] };
    }
    if (first.kind === 'none') continue;
    kinds.push(first.kind);
    targets[first.kind].push(...first.targets);
  }
  if (!kinds.length) return { kind: 'run', targets: [] };
  // A mix of looking around reads as the strongest of it: a search, else a read.
  const kind = kinds.includes('search') ? 'search' : kinds.includes('read') ? 'read' : 'list';
  const unique = [...new Set(targets[kind].filter((target) => target && target !== '-' && target.length <= 200))];
  return { kind, targets: unique.slice(0, 4) };
}

// "Read package.json", "Read 3 files", "Searched for TODO", "Listed src".
export function commandActivityLabel(intent, { live = false } = {}) {
  if (!intent || intent.kind === 'run') return '';
  const names = intent.targets.map(base);
  const short = (text) => (text.length > 48 ? text.slice(0, 45) + '…' : text);
  if (intent.kind === 'read') {
    if (names.length === 1) return (live ? 'Reading ' : 'Read ') + short(names[0]);
    return (live ? 'Reading ' : 'Read ') + (names.length > 1 ? names.length + ' files' : 'a file');
  }
  if (intent.kind === 'search') return names.length ? (live ? 'Searching for ' : 'Searched for ') + short(intent.targets[0]) : (live ? 'Searching the project' : 'Searched the project');
  if (intent.kind === 'list') {
    const dir = intent.targets[0] && intent.targets[0] !== '.' ? short(intent.targets[0].replace(/\/+$/, '')) : '';
    return dir ? (live ? 'Listing ' : 'Listed ') + dir : (live ? 'Looking through the project' : 'Listed project files');
  }
  return '';
}
