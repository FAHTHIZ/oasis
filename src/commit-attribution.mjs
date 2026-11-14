// Keeps commits and pull requests credited to the people who own them.
//
// Coding agents (and the models behind them) like to append "Co-authored-by:
// <Some AI> <noreply@...>" trailers or "Generated with <tool>" footers. GitHub
// turns those trailers into extra avatars on every commit and in the
// contributor list. OASIS never adds them on its own, and this module removes
// them from every message OASIS writes itself (auto-commit, the GitHub
// Action), and gives every OASIS-made commit a human identity instead of a
// "[bot]" account.
//
// Text the user configured on purpose (settings.attribution.commit/pr) is not
// passed through here; that is an explicit choice, not something OASIS added.

// Names of AI tools, assistants, vendors and automation accounts. Matched as
// whole words, case-insensitively, against a trailer's name and address.
const AI_NAMES = [
  'ai', 'llm', 'gpt', 'chatgpt', 'openai', 'codex', 'claude', 'anthropic', 'copilot', 'github copilot',
  'gemini', 'bard', 'google ai', 'jules', 'perplexity', 'cursor', 'cursor agent', 'devin', 'cognition',
  'aider', 'cline', 'roo', 'roo code', 'kilo code', 'continue', 'windsurf', 'codeium', 'tabnine',
  'amazon q', 'codewhisperer', 'kiro', 'qodo', 'codium', 'sourcegraph', 'cody', 'amp', 'factory', 'droid',
  'opencode', 'goose', 'hermes', 'nous', 'kimi', 'moonshot', 'qwen', 'deepseek', 'mistral', 'grok', 'xai',
  'llama', 'ollama', 'oasis', 'sweep', 'coderabbit', 'replit', 'lovable', 'bolt', 'v0', 'manus', 'openhands',
  'allhands', 'all hands', 'warp', 'zed', 'augment', 'trae', 'junie', 'jetbrains ai', 'gitlab duo', 'duo',
  'assistant', 'agent', 'bot', 'dependabot', 'renovate', 'github-actions', 'actions-user'
];

const NAME_PATTERN = new RegExp('(?:^|[^a-z0-9])(?:' + AI_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_-]*')).join('|') + ')(?:$|[^a-z0-9])', 'i');
// Addresses that belong to tools or automation rather than people: GitHub
// App and bot accounts, and the no-reply or agent mailboxes AI vendors use
// (noreply@anthropic.com, cursoragent@cursor.com, devin-ai-integration[bot]...).
// A person at one of those companies with their own address is kept.
const AI_DOMAINS = '(?:anthropic\\.com|openai\\.com|cursor\\.(?:sh|com)|perplexity\\.ai|cognition(?:-labs)?\\.(?:ai|com)|devin\\.ai|aider\\.chat|codeium\\.com|windsurf\\.com|tabnine\\.com|sourcegraph\\.com|deepmind\\.com|google\\.com|x\\.ai|mistral\\.ai|moonshot\\.(?:ai|cn)|deepseek\\.com|qwen\\.ai|replit\\.com|lovable\\.dev|factory\\.ai|ampcode\\.com|sourcegraph\\.com|warp\\.dev|zed\\.dev|augmentcode\\.com|jetbrains\\.com|all-hands\\.dev|coderabbit\\.ai|github\\.com|oasis\\.invalid)';
const ADDRESS_PATTERN = new RegExp('\\[bot\\]|(?:^|[^a-z0-9])bots?@|^[^@]*(?:no-?reply|agent|assistant|copilot|claude|codex|gemini|devin|aider|(?:^|[^a-z])ai(?:[^a-z]|$))[^@]*@(?:[a-z0-9-]+\\.)*' + AI_DOMAINS + '$|@(?:[a-z0-9-]+\\.)*(?:aider\\.chat|devin\\.ai|perplexity\\.ai|oasis\\.invalid)$', 'i');

// Trailers that only ever carry credit; any of these naming a tool or bot goes.
const CREDIT_TRAILERS = /^(?:co-authored-by|co-author|coauthored-by|co-developed-by|assisted-by|generated-by|created-by|made-with|written-by|authored-by|ai-assisted|ai-generated|with-help-from|helped-by|signed-off-by|reviewed-by|suggested-by)\s*:/i;
// Footer lines like "🤖 Generated with [Claude Code](https://claude.ai/code)".
const GENERATED_FOOTER = /^\s*(?:<sub>\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(?:generated|created|written|made|built|authored|drafted|produced|co-?authored|assisted)\s+(?:with|by|using|via|in)\b.*$/iu;

// True when the trailer or footer credits an AI tool or an automation account.
export function isAiCredit(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (CREDIT_TRAILERS.test(text)) {
    const value = text.slice(text.indexOf(':') + 1).trim();
    const address = (value.match(/<([^>]*)>/) || [])[1] || '';
    const name = value.replace(/<[^>]*>/, '').trim();
    if (ADDRESS_PATTERN.test(address) || (!address && ADDRESS_PATTERN.test(value))) return true;
    // A tool's name alone is not enough when a person's own address follows
    // ("Claude Monet <monet@example.com>"); a tool's credit has no address or
    // a no-reply one.
    return NAME_PATTERN.test(' ' + name + ' ') && (!address || /(?:^|[.+_-])no-?reply(?:[.+_-]|@)|users\.noreply\.github\.com$/i.test(address) || NAME_PATTERN.test(' ' + address.replace(/[@.+_-]+/g, ' ') + ' ') && !/@(?:gmail|outlook|hotmail|yahoo|icloud|proton(?:mail)?|pm)\./i.test(address));
  }
  if (GENERATED_FOOTER.test(text)) return NAME_PATTERN.test(' ' + text.replace(/https?:\/\/\S+/g, (url) => ' ' + url.replace(/[/:.]+/g, ' ') + ' ') + ' ');
  return false;
}

// Removes AI and bot credit trailers and "Generated with ..." footers from a
// commit message or pull request body. Human trailers and the rest of the
// text are kept as written; trailing blank lines left behind are trimmed.
export function stripAiAttribution(message) {
  const text = String(message ?? '');
  if (!text) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !isAiCredit(line));
  if (kept.length === lines.length) return text;
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  // A separator ("---") left dangling at the end only framed the footer.
  while (kept.length && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(kept[kept.length - 1])) {
    kept.pop();
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  }
  return kept.join(eol) + (/\r?\n$/.test(text) && kept.length ? eol : '');
}

// The identity OASIS commits as in CI: the person who triggered the run, with
// their GitHub noreply address so the commit links to their profile. Never a
// "[bot]" account. Explicit inputs win; then the triggering actor; then the
// repository owner; then whatever Git is already configured with (empty).
export function commitIdentity(env = process.env, { name = '', email = '' } = {}) {
  const human = (login) => login && !/\[bot\]$|^(?:github-actions|dependabot|renovate)/i.test(login) ? login : '';
  const actor = human(env.GITHUB_TRIGGERING_ACTOR) || human(env.GITHUB_ACTOR);
  const actorId = actor && actor === (env.GITHUB_ACTOR || '') ? String(env.GITHUB_ACTOR_ID || '').trim() : '';
  const owner = human(env.GITHUB_REPOSITORY_OWNER || String(env.GITHUB_REPOSITORY || '').split('/')[0]);
  const ownerId = owner && owner === actor ? actorId : String(env.GITHUB_REPOSITORY_OWNER_ID || '').trim();
  const login = actor || owner;
  const id = actor ? actorId : ownerId;
  const resolvedName = String(name || '').trim() || login;
  const resolvedEmail = String(email || '').trim() || (login ? (/^\d+$/.test(id) ? id + '+' : '') + login + '@users.noreply.github.com' : '');
  return { name: resolvedName, email: resolvedEmail };
}

// The rule given to the model so commits and pull requests it writes credit
// only the user. Settings-provided attribution text overrides it.
export const NO_AI_ATTRIBUTION_RULE = 'Never add Co-authored-by, Generated-by, Signed-off-by or similar trailers, or "Generated with ..." footers, that credit an AI, a tool, a model or a bot (including OASIS) to commit messages, tags or pull request descriptions, and never commit as a bot identity. Commits belong to the user.';

// `git commit` argv as the agent wrote it, with AI credit removed from -m /
// --message values and AI --trailer entries dropped. Returns the same array
// when nothing changed. Only the arguments after `commit` are touched.
export function sanitizeCommitArgv(command, args = []) {
  if (!Array.isArray(args) || !args.length) return args;
  const all = [String(command || ''), ...args.map(String)];
  const at = all.findIndex((part, index) => part === 'commit' && all.slice(0, index).some((item) => item === 'git' || /[\\/]git(?:\.exe)?$/i.test(item)));
  if (at === -1) return args;
  const offset = at - 1; // index in args of "commit" is at - 1
  const out = args.slice(0, offset + 1);
  let changed = false;
  for (let index = offset + 1; index < args.length; index++) {
    const arg = String(args[index]);
    if (arg === '--') { out.push(...args.slice(index)); break; }
    if ((arg === '-m' || arg === '--message' || arg === '--trailer') && index + 1 < args.length) {
      const value = String(args[index + 1]);
      index++;
      if (arg === '--trailer') {
        if (isAiCredit(value.replace(/^([^:=]+)=/, '$1: '))) { changed = true; continue; }
        out.push(arg, value); continue;
      }
      const clean = stripAiAttribution(value);
      if (clean !== value) changed = true;
      if (!clean.trim() && arg === '-m' && out.some((item) => item === '-m' || item === '--message' || /^--message=|^-m./.test(item))) continue;
      out.push(arg, clean);
      continue;
    }
    const inline = arg.match(/^(--message=|--trailer=|-m)([\s\S]+)$/);
    if (inline) {
      if (inline[1] === '--trailer=') {
        if (isAiCredit(inline[2].replace(/^([^:=]+)=/, '$1: '))) { changed = true; continue; }
        out.push(arg); continue;
      }
      const clean = stripAiAttribution(inline[2]);
      if (clean !== inline[2]) changed = true;
      out.push(inline[1] + clean);
      continue;
    }
    out.push(arg);
  }
  return changed ? out : args;
}
