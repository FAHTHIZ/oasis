// Turn guards: what counts as verification, nudges for stalled or evasive replies,
// retry/cycle/thrash limits and the end-of-turn verification checklist.
// Extracted from agent.mjs, which re-exports the public names.

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { isTestPath } from './test-tamper.mjs';
import { runLsp, serverForFile } from './lsp.mjs';
import { isLocalModelEndpoint } from './local-context.mjs';
export { MAX_EMPTY_REPLY_NUDGES, EMPTY_REPLY_NUDGE, EMPTY_REPLY_NOTICE, providerStopNotice, providerCutNotice } from './empty-reply.mjs';
export const MAX_SESSION_TOOL_CALLS = 10000;

export const SOURCE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java',
  '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
  '.kts', '.vue', '.svelte', '.html', '.css', '.json', '.toml', '.yaml', '.yml'
]);
const VERIFICATION_TASKS = new Set([
  'test', 'tests', 'check', 'lint', 'build', 'typecheck', 'type-check', 'verify',
  'clippy', 'vet', 'compile', 'compileall'
]);
export const VERIFICATION_RUNNERS = new Set([
  'pytest', 'vitest', 'jest', 'mocha', 'tap', 'ava', 'eslint', 'prettier', 'tsc',
  'pyright', 'mypy', 'ruff', 'flake8', 'tox', 'nox', 'phpunit', 'phpstan',
  'stylelint', 'shellcheck', 'golangci-lint', 'checkstyle', 'swiftlint'
]);

export function normalizeReviewPath(value) {
  let normalized = String(value || '').split(path.sep).join('/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.includes('//')) normalized = normalized.replace('//', '/');
  return normalized;
}

function isVerificationTaskToken(value) {
  const token = String(value || '').toLowerCase();
  return VERIFICATION_TASKS.has(token) || token.startsWith('test:') ||
    token.startsWith('check:') || token.startsWith('lint:');
}

export function executableName(value) {
  return path.basename(String(value || '')).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

function hasHelpOrVersionArgument(args) {
  return args.some((item) => ['--help', '-h', '--version', '-v'].includes(item));
}

function isDirectVerificationRunner(executable, args) {
  if (!VERIFICATION_RUNNERS.has(executable) || hasHelpOrVersionArgument(args)) return false;
  if (executable === 'vitest') return args.includes('run') || args.includes('--run');
  if (executable === 'prettier') return args.includes('--check') || args.includes('--list-different');
  if (executable === 'eslint' || executable === 'stylelint' || executable === 'shellcheck') {
    return args.some((item) => item && !item.startsWith('-'));
  }
  if (executable === 'tsc') return !args.includes('--init');
  return true;
}

function isTestScriptPath(value) {
  const text = String(value || '').toLowerCase().replace(/\\/g, '/');
  if (!/\.(?:c|m)?(?:js|ts|jsx|tsx)$|\.(?:py|rb|php|sh|bash|zsh)$/.test(text)) return false;
  const base = text.split('/').pop().replace(/\.[^.]+$/, '');
  if (/(?:^|[._-])(?:tests?|spec|specs|check|checks|verify|selftest)(?:[._-]|$)/.test(base)) return true;
  return /(?:^|\/)(?:tests?|__tests__|spec)\//.test(text);
}

export function isVerificationCommand(command, args) {
  const executable = executableName(command);
  const argv = (Array.isArray(args) ? args : []).map((item) => String(item || '').toLowerCase());
  if (!executable || hasHelpOrVersionArgument(argv)) return false;

  // Package-manager script names are command positions, never arbitrary values
  // anywhere in argv. Thus echo test cannot satisfy the verification gate.
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const first = argv[0] || '';
    if (isVerificationTaskToken(first)) return true;
    if (first === 'run' && isVerificationTaskToken(argv[1] || '')) return true;
    if (first === 'exec' || first === 'x' || first === 'dlx') {
      const start = argv.indexOf('--') >= 0 ? argv.indexOf('--') + 1 : 1;
      for (let i = start; i < argv.length; i++) {
        const candidate = executableName(argv[i]);
        if (VERIFICATION_RUNNERS.has(candidate)) {
          return isDirectVerificationRunner(candidate, argv.slice(i + 1));
        }
      }
    }
    // bun test is a built-in test runner; bun run is handled above.
    return executable === 'bun' && first === 'test';
  }

  if (['make', 'gmake', 'just', 'cargo', 'go', 'gradle', 'mvn', 'mvnw', 'dotnet'].includes(executable)) {
    const first = argv.find((item) => item && !item.startsWith('-')) || '';
    if (executable === 'cargo') return ['test', 'check', 'clippy', 'build'].includes(first);
    if (executable === 'go') return ['test', 'vet', 'build'].includes(first);
    if (executable === 'dotnet') return ['test', 'build'].includes(first) ||
      (first === 'format' && argv.includes('--verify-no-changes'));
    if (executable === 'mvn' || executable === 'mvnw') {
      return ['test', 'verify', 'package', 'compile', 'checkstyle:check'].includes(first);
    }
    if (executable === 'make' || executable === 'gmake' || executable === 'just' || executable === 'gradle') {
      return isVerificationTaskToken(first);
    }
  }

  // A script whose own name says it is a test (node test.mjs, python
  // test_parser.py, bash run_tests.sh, ./check.sh) is a project's test entry.
  if (isTestScriptPath(command)) return true;
  if (['node', 'nodejs', 'deno', 'python', 'python3', 'py', 'ruby', 'php', 'bash', 'sh', 'zsh', 'tsx', 'ts-node'].includes(executable)) {
    const script = argv.find((item) => item && !item.startsWith('-'));
    if (script && (executable !== 'deno' || script === 'run') && isTestScriptPath(executable === 'deno' ? argv.filter((item) => item && !item.startsWith('-'))[1] : script)) return true;
    if (executable === 'deno' && (script === 'test' || script === 'check' || script === 'lint')) return true;
  }
  if (executable === 'node' || executable === 'nodejs') {
    return argv.includes('--test') || (argv.includes('--check') && argv.some((item) => /\.(?:c|m)?(?:js|jsx|ts|tsx)$/i.test(item)));
  }
  if (['python', 'python3', 'py'].includes(executable)) {
    const moduleIndex = argv.indexOf('-m');
    if (moduleIndex < 0 || !argv[moduleIndex + 1]) return false;
    return ['pytest', 'unittest', 'compileall', 'mypy', 'ruff', 'pyright'].includes(argv[moduleIndex + 1]);
  }
  if (['npx', 'pnpx', 'bunx'].includes(executable)) {
    for (let i = 0; i < argv.length; i++) {
      const candidate = executableName(argv[i]);
      if (VERIFICATION_RUNNERS.has(candidate)) {
        return isDirectVerificationRunner(candidate, argv.slice(i + 1));
      }
    }
    return false;
  }
  return isDirectVerificationRunner(executable, argv);
}

export function isCompleteFileRead(args, result) {
  if (!result || typeof result.content !== 'string' || !result.path || result.truncated === true) return false;
  const requestedRange = args && (args.offset !== undefined || args.limit !== undefined);
  if (!requestedRange) {
    // Unranged read_file returns the full bounded text file and has no line-range
    // metadata. Oversized files fail before returning a partial response.
    return result.startLine === undefined && result.totalLines === undefined;
  }
  return Number(result.startLine) === 1 &&
    Number(result.endLine) === Number(result.totalLines) &&
    Number(result.totalLines) >= 1;
}


export const FILE_EDITING_TOOL_NAMES = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit', 'delete_file', 'apply_patch']);
export const RETRY_TRACKED_COMMANDS = new Set(['run_command', 'run_shell', 'powershell']);
// "Create src/lib.mjs ...", "fix the failing test", "add a flag": a request to
// change something, not a question about how to.
export function asksForNewTests(request) {
  const text = String(request || '');
  if (/\b(?:no|without|don'?t|do not|skip|never)\b[^.\n]{0,30}\b(?:new |unit |more )?tests?\b/i.test(text)) return false;
  return /\b(?:add|write|create|include|cover\b[^.\n]{0,20}\bwith)\b[^.\n]{0,60}(?<!\b(?:existing|the|all|current|other|my|our|your) )\b(?:unit |regression |new )?tests?\b(?!\s*(?:still\s+)?(?:pass|passing|green|suite\s+pass))/i.test(text);
}

export function asksForAction(request) {
  const text = String(request || '').trim().replace(/^(?:please|pls|can you|could you|would you|go ahead and|now)[\s,]+/i, '');
  if (/^(?:how|what|why|which|when|where|who|explain|describe|summari[sz]e|review|compare|list|show me how|tell me)\b/i.test(text)) return false;
  return /^(?:create|add|implement|fix|write|make|update|change|modify|refactor|remove|delete|rename|move|build|set up|setup|install|run|edit|replace|convert|migrate|bump|upgrade|generate|scaffold|wire|hook up|port|patch|repair|resolve|finish|complete)\b/i.test(text);
}

// Numbered steps, "you can"/"we can" instructions, or a code block handed to the user.
export function readsLikeInstructions(text) {
  const reply = String(text || '');
  if (!reply.trim()) return false;
  const steps = (reply.match(/^\s*(?:\d+[.)]|step \d+)/gim) || []).length;
  return steps >= 2 || /```/.test(reply) || /\b(?:you can|we can|you(?:'|’)ll need to|you should|follow these steps|here(?:'|’)s how|to do this|save (?:it|this) (?:as|to|in))\b/i.test(reply);
}

// "I need to create this function", "Next, I'll run the tests", "Let me fix that:".
export function announcesNextStep(text) {
  const reply = String(text || '').trim();
  if (!reply || reply.length > 1500) return false;
  if (/\b(?:done|completed|finished|all set|passes|passed|is now|has been|have been)\b/i.test(reply.slice(-300)) && !/\b(?:i need to|next)\b/i.test(reply.slice(-300))) return false;
  return /(?:^|[.!\n]\s*)(?:i need to|i will|i'll|i’ll|let me|next,? i|now i|i should|i am going to|i'm going to|i’m going to|i must)\b[^.!?\n]*[.:]?\s*$/i.test(reply) || /:\s*$/.test(reply);
}

// gpt-oss and other terse models announce a step as a bare imperative
// ("Check util diff.", "Run tests.") and end the turn. Only a short,
// single-line reply with no code and no "you" counts: "Run `npm start` to
// launch it" is advice to the user, not an unfinished step.
export function announcesTerseStep(text) {
  const reply = String(text || '').trim();
  if (!reply || reply.length > 120 || /[`\n]/.test(reply) || /\byou(?:r)?\b/i.test(reply)) return false;
  return /^(?:now,?\s+|next,?\s+|then,?\s+)?(?:check|run|re-?run|read|open|inspect|view|look at|review|verify|test|search|grep|list|examine|diff|compare)\b(?:[^.!?]|\.(?=\w))*[.:]?$/i.test(reply);
}

export const GATE_FOLLOWUP_NUDGE = '<system-reminder>You named the next verification step but ended your turn without doing it. Do it now with a tool call; then give the user your final answer.</system-reminder>';

// "I cannot proceed", "I'm unable to", "I apologize, but ..." after a tool error.
export function givesUpEarly(text) {
  const reply = String(text || '').trim();
  if (!reply || reply.length > 1500) return false;
  return /\b(?:i (?:cannot|can't|can’t|am unable to|'m unable to|’m unable to) (?:proceed|continue|complete|do (?:this|that)|make (?:this|the) change)|unable to (?:proceed|complete)|i apologi[sz]e, but)\b/i.test(reply);
}

export const GIVE_UP_NUDGE = '<system-reminder>Do not give up yet: nothing has been changed and the user asked for this change. A tool error is information, not a dead end. Read the error, change your approach (for example, use write_file to create a new file, or read_file first to copy the exact text for edit_file), and try again. Only stop if the task is truly impossible, and then explain exactly why.</system-reminder>';

// Small models sometimes emit a canned refusal ("I'm sorry, but I can't assist
// with that.") for ordinary coding tasks. Only short, reason-free refusals count.
export function refusesSpuriously(text) {
  const reply = String(text || '').trim();
  if (!reply || reply.length > 240) return false;
  if (/\b(?:because|harm|malicious|illegal|unsafe|danger|policy|credential|password|exploit|malware)\b/i.test(reply)) return false;
  return /\b(?:i(?:'m| am|’m) sorry,? but )?i (?:can't|cannot|can’t|won't|am not able to|'m not able to|’m not able to) (?:assist|help) with (?:that|this)(?: request)?\b/i.test(reply)
    || /^i(?:'m| am|’m) sorry,? (?:but )?(?:i )?(?:can't|cannot|can’t) (?:do|fulfil|fulfill|complete) (?:that|this)/i.test(reply);
}

const FENCE_LANGS = {
  '.js': ['js', 'javascript', 'mjs', 'cjs', 'node'], '.mjs': ['js', 'javascript', 'mjs', 'node'], '.cjs': ['js', 'javascript', 'cjs', 'node'],
  '.ts': ['ts', 'typescript'], '.tsx': ['tsx', 'ts', 'typescript'], '.jsx': ['jsx', 'js', 'javascript'],
  '.py': ['py', 'python', 'python3'], '.go': ['go', 'golang'], '.rs': ['rs', 'rust'], '.rb': ['rb', 'ruby'], '.sh': ['sh', 'bash', 'shell']
};

// Weak models sometimes put the whole new file in a fenced block instead of
// calling write_file. When the request names one new file, take the largest
// block in that file's language (or an unlabeled one) as its content.
export function fencedFileFromReply(request, reply) {
  const hint = String(request || '').match(/(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w-]+\.(?:m?[jt]sx?|cjs|py|go|rs|rb|sh))(?=$|[\s`'"),:;.])/);
  if (!hint) return null;
  const file = hint[1];
  const langs = FENCE_LANGS[path.extname(file).toLowerCase()] || [];
  let best = '';
  for (const match of String(reply || '').matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)) {
    const lang = match[1].toLowerCase();
    if (lang && !langs.includes(lang)) continue;
    const body = match[2];
    if (body.trim().split('\n').length < 2) continue;
    // Tutorial pseudo-code that "calls" the agent's own tools is not file content.
    if (/\b(?:read_file|write_file|edit_file|run_command|git_diff)\s*\(/.test(body)) continue;
    // Nor are tool calls written as JSON ({"name": "edit_file", "arguments": ...}).
    if (/^\s*[\[{]\s*"(?:name|tool|function)"\s*:/.test(body) && /"(?:arguments|parameters|args|input)"\s*:/.test(body)) continue;
    if (body.length > best.length) best = body;
  }
  return best ? { path: file, content: best.endsWith('\n') ? best : best + '\n' } : null;
}

// The file a request names ("Create src/lib.mjs ..."), as a concrete next step.
export function targetFileHint(request) {
  const match = String(request || '').match(/(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w-]+\.(?:m?[jt]sx?|cjs|py|go|rs|rb|java|kt|cs|cpp|cc|c|h|hpp|php|swift|json|ya?ml|toml|md|html|css|sh))(?=$|[\s`'"),:;.])/);
  return match ? '\n<system-reminder>The file to work on is ' + match[1] + '. Your next message should be a write_file or edit_file call for it.</system-reminder>' : '';
}

// "Create src/lib.mjs exporting ..." names the one file the request wants.
export function requestedNewFile(request) {
  const text = String(request || '').trim().replace(/^(?:please|pls|now)[\s,]+/i, '');
  const match = text.match(/^(?:create|write|add)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(?:called\s+|named\s+|at\s+)?[`'"]?((?:[\w.-]+\/)*[\w-]+\.[A-Za-z][\w]{0,7})[`'"]?(?=$|[\s,:;.)])/i);
  return match && !match[1].startsWith('.') && !/\.\./.test(match[1]) ? match[1] : '';
}

// The model created a different file than the one the request named (a 4B model
// wrote src/utils.mjs for "Create src/lib.mjs ..."), so the caller cannot find it.
export function wrongFileNudge(request, verification, exists) {
  const target = requestedNewFile(request);
  const created = [...(verification && verification.createdPaths || [])];
  if (!target || !created.length || verification.changedPaths.has(target) || created.includes(target)) return '';
  if (exists(target)) return '';
  return '<system-reminder>The request asks for ' + target + ', but you created ' + created.join(', ') + ' and ' + target + ' does not exist yet. Create ' + target + ' with write_file now (move the code there, and delete ' + (created.length === 1 ? created[0] : 'the other files') + ' if nothing else needs ' + (created.length === 1 ? 'it' : 'them') + '), then check it and finish.</system-reminder>';
}

export const UNREADABLE_CALL_NUDGE = (names) => '<system-reminder>Your ' + names.join(', ') + ' call could not be read (invalid JSON) and did not run, and calls after it in the same message were skipped. Send it again as a single real tool call. For file content, escape newlines as \\n and quotes as \\" inside the JSON string.</system-reminder>';

export const REFUSAL_NUDGE = '<system-reminder>This is an ordinary software task in the user\'s own repository. Start now with one tool call: use write_file to create a new file, or read_file to look at an existing one, then edit_file. If you believe the request is actually harmful, say specifically why.</system-reminder>';

// "I have created clampInteger in src/lib.mjs" when no file changed this turn.
export function claimsUnmadeChange(text) {
  return /\b(?:i(?:'ve|’ve| have)?|i've)\s+(?:now\s+|successfully\s+|already\s+)?(?:created|added|updated|modified|written|wrote|implemented|fixed|changed|edited|refactored|removed|deleted|renamed|made (?:the|these|those|this|all|your) (?:change|changes|edit|edits|update|updates)|completed the (?:change|task|implementation))\b(?!\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:task|todo|to-do|plan|list|checklist)\b)/i.test(String(text || ''))
    || /\b(?:has|have) been (?:created|added|updated|modified|written|implemented|fixed)\b/i.test(String(text || ''))
    // Passive "X is fixed / was updated" (seen live: qwen3:0.6b answered "The
    // function `sum` in math.mjs is fixed to return a + b." with no tool call).
    // Conditions and plans ("is fixed once", "will be updated") do not count.
    || /\b(?:is|are|was|were) (?:now |successfully )?(?:fixed|updated|modified|corrected|implemented|created|changed|edited)\b(?!\s+(?:when|once|if|after|by running|later)\b)/i.test(String(text || ''));
}

export const FALSE_CLAIM_NUDGE = '<system-reminder>Your reply says you made a change, but no file has been changed in this turn: no write_file or edit_file call succeeded. Do not report work that did not happen. Make the change now with write_file or edit_file, then check it.</system-reminder>';

export const CONTINUE_NUDGE = '<system-reminder>You said what you will do next but ended your turn without doing it, and nothing has changed yet. Do that step now with a tool call. If a tool failed, read its error and fix the call (for example, use write_file to create a file that does not exist yet).</system-reminder>';

export const ACTION_NUDGE = '<system-reminder>You described the work instead of doing it. The user asked you to make this change, and you have tools to do it. Do it now: read what you need, then use write_file or edit_file to make the change and run_command to check it. Do not explain the steps again or ask the user to do them.</system-reminder>';

// Local servers default to creative sampling (llama-server 0.8, Ollama 0.7-0.8),
// which makes small models drift between tool-call formats and invent
// arguments. Agent work wants near-greedy decoding. Hosted APIs keep their own
// defaults unless a temperature is configured.
// Lets the model ask for several tool calls in one response. The executor runs
// consecutive read-only calls concurrently and keeps edits in order, so batching
// reads saves a model round trip per call. OASIS_PARALLEL_TOOL_CALLS=0 (or
// "parallelToolCalls": false) restores one call per response for gateways or
// local models that handle multiple calls poorly.
// OpenAI routes requests that share a prompt_cache_key to the same prompt cache,
// which raises cache hits (cheaper, faster) for a long agent conversation, as
// Codex does with its conversation id. Sent to api.openai.com by default (other
// Responses gateways may reject unknown fields); OASIS_PROMPT_CACHE_KEY=1 sends
// it to any Responses endpoint, =0 never. Subagents get their own key.
export function promptCacheKeyField(session, config = {}, env = process.env) {
  const flag = String(env.OASIS_PROMPT_CACHE_KEY ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return {};
  let host = '';
  try { host = new URL(String(config.baseURL || 'https://api.openai.com/v1')).hostname.toLowerCase(); } catch {}
  if (!['1', 'true', 'on', 'yes'].includes(flag) && host !== 'api.openai.com') return {};
  const base = String(session && (session.sessionId || (session.promptCacheSeed ||= randomUUID())) || '');
  if (!base) return {};
  const key = 'oasis-' + createHash('sha256').update(base + '\0' + String(session.agentId || 'main')).digest('hex').slice(0, 32);
  return { prompt_cache_key: key };
}

export function parallelToolCalls(config = {}, env = process.env) {
  const flag = String(env.OASIS_PARALLEL_TOOL_CALLS ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return false;
  if (['1', 'true', 'on', 'yes'].includes(flag)) return true;
  return config.parallelToolCalls !== false;
}

export function samplingTemperature(config = {}, env = process.env) {
  const configured = config.temperature !== undefined ? config.temperature : env.OASIS_TEMPERATURE;
  if (configured !== undefined && configured !== '') {
    const value = Number(configured);
    return Number.isFinite(value) && value >= 0 && value <= 2 ? { temperature: value } : {};
  }
  return isLocalModelEndpoint(config, env) ? { temperature: 0.2 } : {};
}

// Assisted verification is on for local endpoints and windows of 32K or less;
// settings.assistedVerification or OASIS_ASSISTED_VERIFICATION force it on/off.
export function assistedVerificationEnabled(session, env = process.env) {
  const flag = String(env.OASIS_ASSISTED_VERIFICATION || '').trim();
  if (/^(?:0|false|off|no)$/i.test(flag)) return false;
  if (/^(?:1|true|on|yes)$/i.test(flag)) return true;
  const setting = session && session.settings && session.settings.assistedVerification;
  if (typeof setting === 'boolean') return setting;
  const config = (session && session.config) || {};
  // A detected local server, or a window known (configured or probed) to be
  // small. The 32K fallback for unknown models does not count.
  if (session && session.localContext && session.localContext.contextLength > 0) return true;
  const known = Number(config.contextWindow) || Number(env.OASIS_CONTEXT_WINDOW) || 0;
  return known > 0 && known <= 32_768;
}

export const NPM_PLACEHOLDER_TEST = /no test specified/i;

// The project's own test command, detected from its manifest.
export async function detectProjectTestCommand(root) {
  const exists = async (name) => { try { await stat(path.join(root, name)); return true; } catch { return false; } };
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const script = pkg && pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test : '';
    if (script && !NPM_PLACEHOLDER_TEST.test(script)) {
      const runner = await exists('pnpm-lock.yaml') ? 'pnpm' : await exists('yarn.lock') ? 'yarn' : await exists('bun.lockb') || await exists('bun.lock') ? 'bun' : 'npm';
      return { command: runner, args: ['test'] };
    }
  } catch { /* no usable package.json */ }
  if (await exists('Cargo.toml')) return { command: 'cargo', args: ['test', '--quiet'] };
  if (await exists('go.mod')) return { command: 'go', args: ['test', './...'] };
  if (await exists('pytest.ini') || await exists('pyproject.toml') || await exists('setup.cfg') || await exists('tox.ini')) {
    if (await exists('tests') || await exists('test') || await exists('pytest.ini')) return { command: 'python3', args: ['-m', 'pytest', '-q'] };
  }
  return null;
}

// The quickest relevant check: the tests that import the changed files
// (src/repo-map.mjs findRelatedTests), with a command for the project's runner.
// Hub modules reach most of a suite in two hops, so only the nearest group is named.
export function nearestRelatedTests(related, { max = 8 } = {}) {
  if (!Array.isArray(related) || !related.length) return [];
  const best = related[0].distance;
  const near = related.filter((entry) => entry.distance === best);
  const next = near.length < 3 ? related.filter((entry) => entry.distance === best + 1) : [];
  return [...near, ...next].slice(0, max).map((entry) => entry.path);
}

export async function relatedTestCommand(root, tests) {
  if (!tests.length) return null;
  if (tests.every((file) => file.endsWith('.py'))) return { command: 'python3', args: ['-m', 'pytest', '-q', ...tests] };
  if (!tests.every((file) => /\.(?:m?[jt]sx?|cjs)$/.test(file))) return null;
  let script = '';
  try { const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); script = pkg && pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test : ''; } catch {}
  if (/\bvitest\b/.test(script)) return { command: 'npx', args: ['vitest', 'run', ...tests] };
  if (/\bjest\b/.test(script)) return { command: 'npx', args: ['jest', ...tests] };
  if (/\bnode\b[^&|;]*--test\b|scripts\/run-tests\.mjs/.test(script) || (!script && tests.every((file) => /\.m?js$/.test(file)))) return { command: 'node', args: ['--test', ...tests] };
  return null;
}

export async function relatedTestsHint(root, changedPaths) {
  const sources = [...changedPaths].filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  if (!sources.length) return '';
  let related = [];
  // Bounded: a hint is not worth holding up the turn on a huge tree.
  let timer;
  try {
    const search = (await import('./repo-map.mjs')).findRelatedTests(root, sources, { limit: 40 });
    related = await Promise.race([search, new Promise((resolve) => { timer = setTimeout(() => resolve([]), 3000); })]);
  } catch { return ''; } finally { clearTimeout(timer); }
  const tests = nearestRelatedTests(related);
  if (!tests.length) return '';
  const command = await relatedTestCommand(root, tests);
  return 'Tests that import the changed files: ' + tests.join(', ') + '.' + (command ? ' A quick first check: `' + [command.command, ...command.args].join(' ') + '`.' : '') + ' Then run the full suite if it is practical.';
}

export async function assistedVerificationCalls(root, verification) {
  const calls = [];
  const changed = [...verification.changedPaths];
  if (!diffReviewComplete(verification)) {
    let git = false;
    try { await stat(path.join(root, '.git')); git = true; } catch { /* not a Git checkout */ }
    if (git) calls.push({ name: 'git_diff', args: {} });
    else for (const file of changed.slice(0, 3)) calls.push({ name: 'read_file', args: { path: file } });
  }
  if (verification.lastVerificationExitCode === 0) {
    for (const file of unloadedNewModules(verification).slice(0, 3)) calls.push({ name: 'run_command', args: moduleImportCheck(file) });
  }
  if (changed.some((item) => SOURCE_EXTENSIONS.has(path.extname(item).toLowerCase())) && verification.lastVerificationExitCode !== 0 && !changedSourcesAllRan(verification)) {
    const test = await detectProjectTestCommand(root);
    if (test) calls.push({ name: 'run_command', args: test });
    else {
      // No test suite: a syntax check is the best the harness can do. Only
      // these harness-run checks may satisfy the gate this way.
      for (const file of changed.slice(0, 5)) {
        const ext = path.extname(file).toLowerCase();
        if (['.js', '.mjs', '.cjs'].includes(ext)) calls.push({ name: 'run_command', args: { command: 'node', args: ['--check', file] }, syntax: true });
        else if (ext === '.py') calls.push({ name: 'run_command', args: { command: 'python3', args: ['-m', 'py_compile', file] }, syntax: true });
      }
    }
  }
  return calls;
}

export const RETRY_WARN_AT = 3;
export const RETRY_HALT_AT = 5;
// Edit -> same failure -> edit -> same failure: the fixes are not reaching the
// A tool call with the same inputs and the same result, seen in this many of
// the last CYCLE_WINDOW_STEPS model steps with no file edit in between, is a
// no-progress cycle: nudge at the first count, stop at the second.
export const CYCLE_WINDOW_STEPS = 8;
export const CYCLE_WARN_AT = 3;
export const CYCLE_HALT_AT = 4;
// cause. Nudge at 3 identical failures across edits, escalate at 5.
export const THRASH_WARN_AT = 3;
export const THRASH_ESCALATE_AT = 5;

// A stable fingerprint of why a command failed, ignoring timings, counts,
// addresses and temp paths that differ between otherwise identical runs.
export function failureSignature(result) {
  const text = String((result && result.stderr) || '') + '\n' + String((result && result.stdout) || '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const telling = lines.filter((line) => /error|fail|assert|expected|exception|traceback|panic|cannot|undefined|not ok|✗|✖/i.test(line) && !/^#\s*(pass|fail|tests|suites|duration)/i.test(line));
  const picked = (telling.length ? telling : lines.slice(-10)).slice(0, 20);
  return picked.map((line) => line
    .replace(/\b0x[0-9a-f]+\b/gi, '0x')
    .replace(/\/(?:tmp|var\/folders)\/[^\s:'")]+/g, '/tmp/…')
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m)\b/gi, 'T')
    .replace(/\d+/g, 'N')).join('\n') + '\nexit:' + (result && result.exitCode);
}
export const PROTECTED_EDIT_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit', 'generate_image', 'text_to_speech']);
export const AUTO_LSP_EDIT_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit']);

export function successfulMutation(name, result) {
  if (!result || typeof result !== 'object' || result.error) return false;
  if (name === 'edit_file' || name === 'multi_edit' || name === 'notebook_edit') return result.changed === true;
  return name === 'write_file' && typeof result.writtenBytes === 'number';
}

export function lspCallOptions(session, callContext, options) {
  return {
    session,
    settings: session.settings || {},
    approval: callContext && callContext.approval || options.approval,
    autoApprove: Boolean(callContext && callContext.autoApprove),
    ruleAllowed: Boolean(callContext && callContext.ruleAllowed),
    env: callContext && callContext.env || options.env || process.env,
    signal: options.signal
  };
}

// Use a baseline only when this session already has an active, previously
// approved server. A cold start is left to the post-edit check, so a denial or
// unavailable binary cannot cause a duplicate prompt before the edit.
export async function activeLspBaseline(session, file, callContext, options) {
  const server = serverForFile(file, session.settings || {});
  if (!server || !(session.lspClients instanceof Map) || !session.lspClients.has(server.name)) return null;
  try {
    const current = await runLsp(session.root, { operation: 'diagnostics', path: file }, lspCallOptions(session, callContext, options));
    return Array.isArray(current.diagnostics) ? current.diagnostics : null;
  } catch {
    return null;
  }
}

// A file the agent created in this turn needs no diff review: write_file sent
// every byte of it, so rereading only costs a model round trip. Edited and
// overwritten files still need git_diff or a full reread.
// Seen live: a model wrote a new module, ran the existing test suite (which
// never imports it), and finished with a bug the suite could not catch.
// A passing `npm test` proves nothing about a brand-new module that no test
// imports. Seen in a live eval: the model wrote src/lib.mjs with a CommonJS
// `require.main` check in an ES module, ran npm test (green, it never loaded
// the file) and stopped; the module threw on import. New JavaScript modules
// that export something must be imported or run once after the last edit.
const MODULE_CHECK_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

export function newModuleCandidate(file, content) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (!MODULE_CHECK_EXTENSIONS.has(ext) || isTestPath(file)) return false;
  const text = String(content || '');
  if (!/(^|\n)\s*export\s|module\.exports|exports\.[A-Za-z_$]/.test(text)) return false;
  // Browser or bundler code cannot be imported by plain Node.
  if (/\b(?:document|window|navigator|localStorage)\.|<[A-Z][A-Za-z]*[\s/>]|import\s[^;]*?['"][^'"]+\.(?:css|scss|less|svg|png|jpe?g|vue|svelte)['"]|import\.meta\.env/.test(text)) return false;
  // Loading must be quick and side-effect free: skip servers, watchers and CLIs.
  if (/\.listen\(|setInterval\(|process\.stdin|readline|createServer|process\.argv/.test(text)) return false;
  return true;
}

export function unloadedNewModules(state) {
  const changed = [...(state.changedPaths || [])];
  if (changed.some((item) => isTestPath(item))) return [];
  const candidates = state.moduleCandidates instanceof Set ? state.moduleCandidates : new Set();
  const loaded = state.loadedPaths instanceof Set ? state.loadedPaths : new Set();
  return [...candidates].filter((item) => changed.includes(item) && !loaded.has(item));
}

// A command that ran a new module by path (node src/lib.mjs, an import check).
// Running a changed script directly (node hello.mjs, python3 app.py) with
// exit 0 after its last edit is a real check for a small program with no test
// suite. Seen live: "make hello" wrote hello.mjs, ran it ("hi"), and the gate
// still demanded a test, costing a model round trip and a false warning.
const SCRIPT_RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'py', 'ruby', 'php', 'bash', 'sh', 'tsx', 'ts-node']);
export function markRanSources(state, command, args, exitCode) {
  if (exitCode !== 0 || !state || !(state.changedPaths instanceof Set)) return;
  const executable = path.basename(String(command || '')).replace(/\.exe$/i, '').toLowerCase();
  const argv = Array.isArray(args) ? args.map(String) : [];
  let script = '';
  if (SCRIPT_RUNNERS.has(executable)) {
    const positional = argv.filter((item) => item && !item.startsWith('-'));
    script = (executable === 'deno' || executable === 'bun') && positional[0] === 'run' ? positional[1] : positional[0];
  } else if (/^\.{0,2}\//.test(String(command || ''))) script = String(command);
  const file = normalizeReviewPath(script || '');
  if (file && state.changedPaths.has(file)) (state.ranPaths ||= new Set()).add(file);
  // Inline code that imports or opens a changed file and exits 0
  // (node -e "import('./math.mjs').then(...)", python -c "import parser")
  // exercised it as much as `node math.mjs` would.
  const evalAt = SCRIPT_RUNNERS.has(executable) ? argv.findIndex((item) => INLINE_EVAL_FLAGS.has(item)) : -1;
  const code = evalAt >= 0 ? String(argv[evalAt + 1] || '') : '';
  if (!code) return;
  for (const changed of state.changedPaths) {
    if (!SOURCE_EXTENSIONS.has(path.extname(changed).toLowerCase())) continue;
    if (inlineCodeLoads(code, changed, executable)) (state.ranPaths ||= new Set()).add(changed);
  }
}

const INLINE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);
function inlineCodeLoads(code, file, executable) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A quoted path ('./math.mjs', "src/math.mjs") names the file itself.
  if (new RegExp('[\'"`](?:\\./)?' + escaped + '[\'"`]').test(code)) return true;
  if (/^python/.test(executable) || executable === 'py') {
    // python -c "import parser" / "from pkg.parser import x" for pkg/parser.py.
    if (!/\.py$/i.test(file)) return false;
    const dotted = file.replace(/\.py$/i, '').replace(/\//g, '.').replace(/\.__init__$/, '').replace(/[.]/g, '\\.');
    return new RegExp('(?:^|[\\s;])(?:import|from)\\s+' + dotted + '(?:[\\s;,.]|$)').test(code);
  }
  return false;
}

function changedSourcesAllRan(state) {
  const sources = [...state.changedPaths].filter((item) => SOURCE_EXTENSIONS.has(path.extname(item).toLowerCase()));
  const ran = state.ranPaths instanceof Set ? state.ranPaths : new Set();
  return sources.length > 0 && sources.every((item) => ran.has(item));
}

export function markLoadedModules(state, commandText, exitCode) {
  if (exitCode !== 0 || !(state.moduleCandidates instanceof Set) || !state.moduleCandidates.size) return;
  const text = String(commandText || '');
  for (const file of state.moduleCandidates) {
    if (text.includes(file) || text.includes(path.basename(file))) (state.loadedPaths ||= new Set()).add(file);
  }
}

function moduleImportCheck(file) {
  // Running the file loads it the same way an import does. Inline code
  // (node -e, --import) is high risk and never auto-approved, so the check
  // stays a plain `node <file>`; long-running modules are skipped upstream.
  return { command: 'node', args: [file] };
}

export function untestedNewCode(state) {
  const changed = [...(state.changedPaths || [])];
  if (changed.some((item) => isTestPath(item))) return [];
  const created = [...(state.createdPaths || [])].filter((item) => /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|swift)$/i.test(item) && !isTestPath(item));
  if (!created.length) return [];
  return ['New code in ' + created.join(', ') + ' is not exercised by existing tests unless one imports it. Call it directly too — a short script or test with the cases from the request, including edge cases (negative numbers, zero, empty or malformed input) — and fix whatever fails.'];
}

// Once a check has passed after the latest edit, targeted edits (edit_file,
// multi_edit) need no reread either: the model chose each replacement and the
// tool result echoed it. Seen live: the extra review round trip produced a
// second, contradicting final answer. Whole-file overwrites of existing files
// still need a diff, since they can silently drop content.
export function diffReviewComplete(state) {
  return unreviewedPaths(state).length === 0;
}

export function unreviewedPaths(state) {
  if (state.diffReviewedAll) return [];
  const created = state.createdPaths instanceof Set ? state.createdPaths : new Set();
  const overwritten = state.overwrittenPaths instanceof Set ? state.overwrittenPaths : null;
  // Running every changed source cleanly (node math.mjs, or inline code that
  // imports it) counts like a passing check here.
  const checked = state.lastVerificationExitCode === 0 || changedSourcesAllRan(state);
  return [...state.changedPaths].filter((item) => !(state.diffReviewedPaths.has(item) || created.has(item) || (checked && overwritten && !overwritten.has(item))));
}

export function verificationIssues(state) {
  if (!state.changedPaths.size) return [];
  const changed = [...state.changedPaths];
  const issues = [];
  const unreviewed = unreviewedPaths(state);
  if (unreviewed.length) {
    // Name the files: a model that reviewed one diff tends to stop there.
    issues.push('the changed-file diff has not been reviewed (' + unreviewed.slice(0, 8).join(', ') + (unreviewed.length > 8 ? ', …' : '') + ')');
  }
  const ranClean = changedSourcesAllRan(state);
  if (changed.some((item) => SOURCE_EXTENSIONS.has(path.extname(item).toLowerCase())) && state.lastVerificationExitCode !== 0 && !ranClean) {
    issues.push('no relevant test, check, lint, build, or type-check command has passed after the latest code edit');
  }
  const unloaded = state.lastVerificationExitCode === 0 ? unloadedNewModules(state) : [];
  if (unloaded.length) {
    issues.push('the new module ' + unloaded.slice(0, 5).join(', ') + (unloaded.length > 1 ? ' were' : ' was') + ' not loaded or run by any check after the latest edit, so the passing check says nothing about it; import or run it (or add a test that does)');
  }
  if (state.testsRequested && !changed.some((item) => isTestPath(item))) {
    issues.push('the request asked for new tests, but no test file was added or changed; add tests that cover the new behavior and run them');
  }
  if (state.testsRequested && Array.isArray(state.testsOnlyExtended) && state.testsOnlyExtended.length) {
    issues.push('the request asked for a new test, but the change only added assertions inside existing test cases (' + state.testsOnlyExtended.slice(0, 5).join(', ') + '); add a separate test case for this fix, so it passes or fails on its own, and run it');
  }
  if (Array.isArray(state.testTampering) && state.testTampering.length) {
    issues.push('tests were weakened instead of the code being fixed (' + state.testTampering.map((item) => item.file + ': ' + item.reason).join('; ') + '); restore them, or explain to the user why this is intended');
  }
  for (const [file, result] of state.lspVerificationByPath || []) {
    if (!changed.includes(file)) continue;
    if (result.status === 'unavailable') {
      // LSP is optional editor integration, not a substitute for a real code check.
      // A result explicitly marked non-blocking (for example, disabled by the
      // unattended Action policy) remains visible but does not block completion.
      // Source edits still require a recognized project check to pass above.
      if (result.blocking !== false && state.lastVerificationExitCode !== 0 && !ranClean) {
        issues.push('LSP verification unavailable for ' + file + ': ' + String(result.reason || 'no diagnostic result'));
      }
    } else if (Array.isArray(result.newErrors) && result.newErrors.length) {
      issues.push('LSP reports ' + result.newErrors.length + ' new or unclassified error(s) in ' + file);
    }
  }
  return issues;
}

export function appendLspUnavailableNotice(text, state) {
  const changed = new Set(state && state.changedPaths instanceof Set ? state.changedPaths : []);
  const unavailable = [...(state && state.lspVerificationByPath instanceof Map ? state.lspVerificationByPath.entries() : [])]
    .filter(([file, result]) => changed.has(file) && result && result.status === 'unavailable');
  if (!unavailable.length) return String(text || '');
  // A passing project check already verified the change; a missing language
  // server is then noise on every reply (it stays in /status and -p JSON).
  if (state && state.lastVerificationKind && state.lastVerificationExitCode === 0) return String(text || '');
  // Group files that share the same reason so one missing server is one short line.
  const groups = new Map();
  for (const [file, result] of unavailable) {
    const reason = String(result.reason || '').replace(/\s*Meanwhile, use grep or the diagnostics tool\.?/i, '').trim();
    const missing = reason.match(/^No (\S+) language server found\. Install one with: (.+?)\.?$/i);
    const key = missing ? 'no ' + missing[1] + ' language server installed (' + missing[2].replace(/[.\s]+$/, '') + ')' : reason.slice(0, 240).replace(/[.\s]+$/, '') || 'no language server available';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const lines = [...groups.entries()].map(([reason, files]) => (files.length > 3 ? files.slice(0, 3).join(', ') + ' and ' + (files.length - 3) + ' more' : files.join(', ')) + ': ' + reason);
  return String(text || '').trimEnd() + '\n\nLSP verification unavailable for ' + lines.join('; ') + '. Project checks are reported separately; this change was not verified by a language server.';
}
