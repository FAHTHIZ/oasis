// Live diff: a full-screen view of uncommitted changes that redraws as files
// change, so you can watch an agent's edits from a second terminal or a tmux
// split (`oasis diff --watch`, or `/diff --watch` inside a session).
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const ESC = '\x1b[';

function git(root, args, env) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
}

/** Parse `git diff --numstat` output into per-file added/removed counts. */
export function parseNumstat(text) {
  const files = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    files.push({ path: match[3], added: match[1] === '-' ? 0 : Number(match[1]), removed: match[2] === '-' ? 0 : Number(match[2]), binary: match[1] === '-' });
  }
  return files;
}

/** Read the working tree's changes against HEAD (or the index before the first commit). */
export function collectDiff(root, { paths = [], env = process.env } = {}) {
  if (git(root, ['rev-parse', '--is-inside-work-tree'], env).status !== 0) throw new Error('Not a Git repository; the live diff needs Git.');
  const base = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], env).status === 0 ? ['HEAD'] : ['--cached'];
  const patch = String(git(root, ['diff', '--no-color', '--no-ext-diff', ...base, '--', ...paths], env).stdout || '');
  const files = parseNumstat(git(root, ['diff', '--numstat', ...base, '--', ...paths], env).stdout);
  const untracked = String(git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths], env).stdout || '').split('\n').filter(Boolean);
  const signature = createHash('sha1').update(patch).update('\0' + untracked.join('\n')).digest('hex');
  return { patch, files, untracked, signature };
}

function colourLine(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return ESC + '1m' + line + ESC + '0m';
  if (line.startsWith('+')) return ESC + '32m' + line + ESC + '0m';
  if (line.startsWith('-')) return ESC + '31m' + line + ESC + '0m';
  if (line.startsWith('@@')) return ESC + '36m' + line + ESC + '0m';
  if (line.startsWith('diff --git')) return ESC + '1;33m' + line + ESC + '0m';
  return line;
}

function clip(line, cols) {
  // Tabs widen lines unpredictably; show them as two spaces.
  const plain = line.replace(/\t/g, '  ');
  return plain.length > cols ? plain.slice(0, Math.max(1, cols - 1)) + '…' : plain;
}

/** Lines of the scrollable body: the patch, or a summary when stat mode is on. */
export function bodyLines(diff, { stat = false } = {}) {
  const lines = [];
  if (stat) {
    for (const file of diff.files) lines.push((file.binary ? 'binary' : '+' + file.added + ' -' + file.removed).padEnd(12) + file.path);
  } else if (diff.patch.trim()) lines.push(...diff.patch.trimEnd().split('\n'));
  if (diff.untracked.length) {
    if (lines.length) lines.push('');
    lines.push('Untracked files:', ...diff.untracked.map((file) => '  ' + file));
  }
  if (!lines.length) lines.push('No uncommitted changes. Waiting for edits…');
  return lines;
}

/** Index of each "diff --git" header, so n/p can jump between files. */
export function fileStarts(lines) {
  const starts = [];
  lines.forEach((line, index) => { if (line.startsWith('diff --git ')) starts.push(index); });
  return starts;
}

/** Render one full frame (header, body window, key hints) as a string. */
export function renderFrame(diff, view, { cols = 80, rows = 24, color = true, now = new Date() } = {}) {
  const lines = bodyLines(diff, view);
  const height = Math.max(1, rows - 2);
  const top = Math.max(0, Math.min(view.scroll || 0, Math.max(0, lines.length - height)));
  const added = diff.files.reduce((sum, file) => sum + file.added, 0);
  const removed = diff.files.reduce((sum, file) => sum + file.removed, 0);
  const time = now.toTimeString().slice(0, 8);
  const header = clip('OASIS live diff  ' + diff.files.length + ' changed' + (diff.untracked.length ? ', ' + diff.untracked.length + ' untracked' : '') + '  +' + added + ' -' + removed + '  ' + (view.paused ? 'paused' : 'updated ' + time), cols);
  const footer = clip('q quit  j/k scroll  space/b page  n/p file  s ' + (view.stat ? 'patch' : 'summary') + '  w ' + (view.paused ? 'resume' : 'pause') + '  ' + (lines.length > height ? (top + 1) + '-' + Math.min(lines.length, top + height) + '/' + lines.length : ''), cols);
  const body = lines.slice(top, top + height).map((line) => color && !view.stat ? colourLine(clip(line, cols)) : clip(line, cols));
  while (body.length < height) body.push(color ? ESC + '2m~' + ESC + '0m' : '~');
  const inverse = (text) => color ? ESC + '7m' + text.padEnd(cols) + ESC + '0m' : text;
  // Raw mode can turn off newline translation, so end lines with CRLF.
  return [inverse(header), ...body, inverse(footer)].join('\r\n');
}

/** Apply one keypress to the view; returns 'quit' to exit. */
export function applyKey(view, key, lines, rows) {
  const height = Math.max(1, rows - 2);
  const max = Math.max(0, lines.length - height);
  const starts = fileStarts(lines);
  if (key === 'q' || key === '\x03' || key === '\x1b') return 'quit';
  if (key === 'j' || key === '\x1b[B') view.scroll = Math.min(max, (view.scroll || 0) + 1);
  else if (key === 'k' || key === '\x1b[A') view.scroll = Math.max(0, (view.scroll || 0) - 1);
  else if (key === ' ' || key === '\x1b[6~') view.scroll = Math.min(max, (view.scroll || 0) + height);
  else if (key === 'b' || key === '\x1b[5~') view.scroll = Math.max(0, (view.scroll || 0) - height);
  else if (key === 'g') view.scroll = 0;
  else if (key === 'G') view.scroll = max;
  else if (key === 'n') { const next = starts.find((index) => index > (view.scroll || 0)); if (next !== undefined) view.scroll = Math.min(max, next); }
  else if (key === 'p') { const prev = starts.filter((index) => index < (view.scroll || 0)).pop(); view.scroll = prev === undefined ? 0 : prev; }
  else if (key === 's') { view.stat = !view.stat; view.scroll = 0; }
  else if (key === 'w') view.paused = !view.paused;
  return null;
}

/** Run the full-screen live view until the user quits. Without a TTY it prints once. */
export async function runLiveDiff({ root = process.cwd(), paths = [], stat = false, interval = 1000, env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  let diff = collectDiff(root, { paths, env });
  const view = { scroll: 0, stat, paused: false };
  if (!stdout.isTTY || !stdin.isTTY) {
    stdout.write(bodyLines(diff, view).join('\n') + '\n');
    return 0;
  }
  const color = !env.NO_COLOR;
  const draw = () => {
    stdout.write(ESC + 'H' + ESC + '2J' + renderFrame(diff, view, { cols: stdout.columns || 80, rows: stdout.rows || 24, color }));
  };
  stdout.write(ESC + '?1049h' + ESC + '?25l');
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (view.paused) return;
      try {
        const next = collectDiff(root, { paths, env });
        if (next.signature !== diff.signature) { diff = next; draw(); }
      } catch { /* the repository moved mid-read; try again next tick */ }
    }, interval);
    const finish = () => {
      clearInterval(timer);
      stdin.off('data', onKey);
      stdout.off('resize', draw);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(ESC + '?25h' + ESC + '?1049l');
      resolve(0);
    };
    const onKey = (chunk) => {
      const key = String(chunk);
      if (applyKey(view, key, bodyLines(diff, view), stdout.rows || 24) === 'quit') { finish(); return; }
      if (key === 'w' && !view.paused) diff = collectDiff(root, { paths, env });
      draw();
    };
    stdin.on('data', onKey);
    stdout.on('resize', draw);
    draw();
  });
}

/** Open the live diff beside the session: a tmux split when available. */
export function openLiveDiffPane({ root, paths = [], env = process.env, oasisBin = process.argv[1] } = {}) {
  const command = [process.execPath, oasisBin, 'diff', '--watch', ...paths].map((part) => "'" + String(part).replace(/'/g, "'\\''") + "'").join(' ');
  if (env.TMUX) {
    const child = spawn('tmux', ['split-window', '-h', '-c', root, command], { stdio: 'ignore', detached: true, env });
    child.on('error', () => {});
    child.unref();
    return { opened: true, message: 'Opened the live diff in a tmux pane on the right. Press q there to close it.' };
  }
  return { opened: false, message: 'Run `oasis diff --watch` in a second terminal (or a split pane) to follow changes live while this session works.' };
}

export async function diffCommand(args, { env = process.env, root = process.cwd() } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: oasis diff [--watch] [--stat] [PATH...]\n\nShow uncommitted changes. --watch opens a full-screen view that redraws as files change\n(keys: q quit, j/k scroll, n/p next/previous file, s summary, w pause).\n');
    return 0;
  }
  const paths = args.filter((arg) => !arg.startsWith('-'));
  const stat = args.includes('--stat');
  if (args.includes('--watch') || args.includes('-w')) return await runLiveDiff({ root, paths, stat, env });
  const diff = collectDiff(root, { paths, env });
  const lines = bodyLines(diff, { stat });
  const color = process.stdout.isTTY && !env.NO_COLOR;
  process.stdout.write(lines.map((line) => color && !stat ? colourLine(line) : line).join('\n') + '\n');
  return 0;
}
