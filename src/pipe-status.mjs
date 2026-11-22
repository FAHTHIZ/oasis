// Masked exit status detection for shell pipelines. In POSIX shells without
// `set -o pipefail`, `npm test | tail -20` exits with tail's status (0) even
// when the tests failed. Agents then report "tests pass" from a failed run.
// This module spots that pattern and attaches an explicit warning to the
// tool result so the model cannot mistake the exit code for the test result.

import path from 'node:path';

const CHECK_COMMAND = /(?:^|[\s;&(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx?\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck|ci)\b|node\s+--test\b|jest\b|vitest\b|mocha\b|ava\b|tap\b|playwright\s+test\b|cypress\s+run\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|tox\b|nox\b|cargo\s+(?:test|build|check|clippy)\b|go\s+(?:test|build|vet)\b|make\b|cmake\s+--build\b|ctest\b|gradle\w*\s|\.\/gradlew\b|mvn\b|dotnet\s+(?:test|build)\b|tsc\b|eslint\b|ruff\b|mypy\b|pyright\b|rspec\b|bundle\s+exec\s+rspec\b|phpunit\b|swift\s+(?:test|build)\b|deno\s+test\b)/i;
const FILTER_STAGE = /^\s*(?:tail|head|grep|egrep|fgrep|rg|less|more|cat|tee|sort|uniq|wc|sed|awk|cut|tr|column|jq|xargs|fold|nl)\b/;

function splitTopLevelPipes(command) {
  const stages = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"') { current += char + (command[index + 1] || ''); index++; continue; }
      if (char === quote) quote = '';
      current += char;
      continue;
    }
    if (char === '\'' || char === '"') { quote = char; current += char; continue; }
    if (char === '\\') { current += char + (command[index + 1] || ''); index++; continue; }
    if (char === '|' && command[index + 1] === '|') { current += '||'; index++; continue; }
    if (char === '|' && command[index - 1] !== '>') {
      stages.push(current);
      current = '';
      if (command[index + 1] === '&') index++;
      continue;
    }
    current += char;
  }
  stages.push(current);
  return stages;
}

/** Returns a warning when a check command's exit status is hidden by a pipe. */
export function maskedPipelineWarning(command, exitCode, flavor = 'sh') {
  if (flavor === 'powershell') return '';
  const text = String(command || '');
  if (!text.includes('|') || /\bset\s+-[a-z]*o\s+pipefail\b|\bset\s+-o\s+pipefail\b|PIPESTATUS/.test(text)) return '';
  // Only the last pipeline in the command line determines the exit status.
  const lastPipeline = text.split(/;|&&|\|\||\n/).filter((part) => part.trim()).pop() || '';
  const stages = splitTopLevelPipes(lastPipeline);
  if (stages.length < 2) return '';
  const checkStage = stages.slice(0, -1).find((stage) => CHECK_COMMAND.test(stage));
  if (!checkStage) return '';
  const last = stages[stages.length - 1].trim();
  const lastName = (last.match(/^\S+/) || [''])[0];
  if (!FILTER_STAGE.test(last) && Number(exitCode) !== 0) return '';
  return 'exitCode ' + exitCode + ' is the status of the last pipe stage (' + lastName + '), not of `' + checkStage.trim().slice(0, 80) +
    '`. The check itself may have failed. Before reporting it as passing, re-run without the pipe, or prefix the command with `set -o pipefail;`, and confirm the real exit status.';
}

// Shell lines whose exit status does not belong to the check they name:
// `npm test &` returns 0 before the tests run, `exit 0; npm test` and
// `trap 'exit 0' EXIT; npm test` exit 0 whatever happens, and a function,
// alias or PATH override can replace the check with something that always
// passes. None of them counts as a check.
function fakesExitStatus(text) {
  const value = String(text || '').replace(/\d*>&\d*|&>>?|\|&/g, ' ');
  if (/(^|[^&])&(?!&)/.test(value)) return true;
  if (/(^|[;&|(\s])(?:exit|trap|alias|unalias|hash|enable)(?=\s|;|$)/.test(value)) return true;
  if (/\w\s*\(\s*\)\s*\{|(^|[;&|\s])function\s+[\w.-]+/.test(value)) return true;
  if (/(^|[;&|\s])(?:export\s+)?PATH=/.test(value)) return true;
  return false;
}

/**
 * For the verification gate: describe the command whose exit status the shell
 * line actually reports. Returns { command, args, piped } for the first stage of
 * the final pipeline, or null when it cannot be determined simply.
 */
const DIRECTORY_FLAG = /^(?:--prefix|--cwd|--dir|--directory|-C|--manifest-path|--project|-p|--rootdir|--root)$/;

function outsideRoot(dir, base, root) {
  const value = String(dir || '');
  if (!value || /^[~$-]|\$/.test(value)) return true;
  const resolved = path.resolve(base, value);
  const relative = path.relative(path.resolve(root), resolved);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function runsOutside(segments, tokens, root) {
  let cwd = path.resolve(root);
  for (const segment of segments) {
    const words = (segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^(["'])(.*)\1$/, '$2'));
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const dir = words.slice(1).find((word) => !word.startsWith('-') || word === '-');
      if (dir === undefined || outsideRoot(dir, cwd, root)) return true;
      cwd = path.resolve(cwd, dir);
    } else if (words[0] === 'popd') return true;
  }
  if (!['npm', 'pnpm', 'yarn', 'bun', 'make', 'gmake', 'cargo', 'go', 'git', 'pytest', 'tsc', 'npx', 'node'].includes(path.basename(tokens[0]))) return false;
  for (let i = 1; i < tokens.length; i++) {
    const [flag, inline] = tokens[i].includes('=') ? [tokens[i].slice(0, tokens[i].indexOf('=')), tokens[i].slice(tokens[i].indexOf('=') + 1)] : [tokens[i], null];
    if (tokens[i] === '--') break;
    if (!DIRECTORY_FLAG.test(flag)) continue;
    // pytest -p is a plugin, tsc -p a project file inside the tree is fine.
    const dir = inline ?? tokens[i + 1];
    if (flag === '-p' && path.basename(tokens[0]) === 'pytest') continue;
    if (outsideRoot(dir, cwd, root)) return true;
  }
  return false;
}

/** For run_command: whether `npm test --prefix /tmp/x` runs outside `root`. */
export function runsOutsideRoot(command, args, root) {
  return Boolean(root) && runsOutside([], [String(command || '')].concat(Array.isArray(args) ? args.map(String) : []), root);
}

export function shellExitTarget(command, { root = '' } = {}) {
  const text = String(command || '').trim();
  if (!text || /[`$]\(|<\(|\n/.test(text)) return null;
  if (fakesExitStatus(text)) return null;
  const segments = text.split(/;|&&|\|\|/).filter((part) => part.trim());
  // `true || npm test` exits 0 without running the check: after ||, which
  // command's status the line reports is not known from the text.
  if (/\|\|/.test(text)) return null;
  const lastSegment = segments.pop() || '';
  const stages = splitTopLevelPipes(lastSegment);
  const tokens = (stages[0].match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^(["'])(.*)\1$/, '$2'));
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return null;
  // With a workspace root, a check that runs in another directory (cd, pushd,
  // --prefix, -C) says nothing about this one: `cd /tmp/x && npm test`.
  if (root && runsOutside(segments, tokens, root)) return null;
  const pipefail = /\bset\s+-[a-z]*o\s+pipefail\b|\bset\s+-o\s+pipefail\b/.test(text);
  return { command: tokens[0], args: tokens.slice(1), piped: stages.length > 1 && !pipefail };
}
