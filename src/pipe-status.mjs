// Masked exit status detection for shell pipelines. In POSIX shells without
// `set -o pipefail`, `npm test | tail -20` exits with tail's status (0) even
// when the tests failed. Agents then report "tests pass" from a failed run.
// This module spots that pattern and attaches an explicit warning to the
// tool result so the model cannot mistake the exit code for the test result.

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

/**
 * For the verification gate: describe the command whose exit status the shell
 * line actually reports. Returns { command, args, piped } for the first stage of
 * the final pipeline, or null when it cannot be determined simply.
 */
export function shellExitTarget(command) {
  const text = String(command || '').trim();
  if (!text || /[`$]\(|<\(|\n/.test(text)) return null;
  const lastSegment = text.split(/;|&&|\|\|/).filter((part) => part.trim()).pop() || '';
  const stages = splitTopLevelPipes(lastSegment);
  const tokens = (stages[0].match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^(["'])(.*)\1$/, '$2'));
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return null;
  const pipefail = /\bset\s+-[a-z]*o\s+pipefail\b|\bset\s+-o\s+pipefail\b/.test(text);
  return { command: tokens[0], args: tokens.slice(1), piped: stages.length > 1 && !pipefail };
}
