// Small models (and sometimes large ones) commit, push, add remotes or rewrite
// global git config when nobody asked. These writes leave the workspace or are
// hard to undo, so they run only when the current request asks for them.
// Opt out with settings.allowUnrequestedGitWrites or
// OASIS_ALLOW_UNREQUESTED_GIT_WRITES=1.

import { multilingualForbidsChanges } from './multilingual-signals.mjs';

const ACTIONS = [
  { action: 'commit', pattern: /\bgit\s+(?:-c\s+\S+\s+)*commit\b/, intent: /\b(?:commit|commits|committing|committed|amend|ship|check\s*in)\b/i },
  { action: 'push', pattern: /\bgit\s+(?:-c\s+\S+\s+)*push\b/, intent: /\b(?:push|pushing|publish|ship|release|deploy|upload|upstream|pull\s+request|merge\s+request|pr)\b/i },
  { action: 'change git remotes', pattern: /\bgit\s+(?:-c\s+\S+\s+)*remote\s+(?:add|set-url|remove|rm|rename)\b/, intent: /\b(?:remote|remotes|origin|upstream)\b/i },
  { action: 'change global git config', pattern: /\bgit\s+(?:-c\s+\S+\s+)*config\s+(?:[^|;&]*\s)?--(?:global|system)\b/, intent: /\b(?:global|git\s+config|gitconfig|system)\b/i },
  { action: 'open a pull request or create a release', pattern: /\bgh\s+(?:pr\s+(?:create|merge)|release\s+create|repo\s+(?:create|delete|fork))\b/, intent: /\b(?:pull\s+request|pr|release|repo|repository|fork|publish|ship|merge)\b/i }
];

const TOOL_ACTIONS = {
  git_commit: 'commit',
  git_push: 'push',
  create_pull_request: 'open a pull request or create a release'
};

function commandText(name, args) {
  if (name !== 'run_command' && name !== 'bash' && name !== 'powershell') return '';
  const command = String(args && (args.command ?? args.cmd) || '');
  const rest = Array.isArray(args && args.args) ? args.args.map(String).join(' ') : '';
  return (command + ' ' + rest).replace(/\s+/g, ' ').trim();
}

export function unrequestedGitWrite(request, name, args, { settings = {}, env = process.env } = {}) {
  if (settings && settings.allowUnrequestedGitWrites === true) return null;
  if (/^(?:1|true|yes|on)$/i.test(String(env && env.OASIS_ALLOW_UNREQUESTED_GIT_WRITES || ''))) return null;
  const asked = String(request || '');
  let action = TOOL_ACTIONS[name] || null;
  if (!action) {
    const text = commandText(name, args);
    if (!text) return null;
    const hit = ACTIONS.find((entry) => entry.pattern.test(text));
    if (!hit) return null;
    action = hit.action;
  }
  const entry = ACTIONS.find((item) => item.action === action);
  if (entry && entry.intent.test(asked)) return null;
  return 'Not run: the user did not ask you to ' + action + ' in this request. Leave version control to the user. Finish the requested change, report what changed, and mention that it is not committed. If the user wants this, they will ask.';
}

// "Run the tests and tell me which fail. Do not change any files." Seen live:
// in auto mode the model edited the code anyway, and nothing asked a person
// (workspace edits do not reach the classifier). A request that rules out
// file changes, unscoped ("outside src/", "other than README" keep the rest
// editable; "the code" is left alone because "fix the test, don't change the
// code" means the tests may change), refuses the file-editing tools for that
// request.
const CHANGE_VERB = '(?:change|changing|modify|modifying|edit|editing|touch|touching|alter|altering|write\\s+to|writing\\s+to|update|updating)';
const CHANGE_OBJECT = '(?:(?:any|the|my|our|your|these|those)\\s+)?(?:files?|codebase|anything|repo|repository|workspace)';
// Only an unqualified object counts: it must end the clause ("any files.",
// "anything, just look", "the repo and tell me"), not lead into a scope or a
// narrower thing ("the files in tests/", "anything else", "files named x").
const CLAUSE_END = '(?=\\s*(?:$|[.,;:!?)\\n]|(?:and|just|only|please|yet|at\\s+all|whatsoever|while|until|for\\s+now|here|now)\\b|[-–—]\\s))';
const NO_FILE_CHANGES = new RegExp('\\b(?:do\\s+not|don[\'’]?t|never|without|no\\s+need\\s+to)\\s+(?:\\w+\\s+)?' + CHANGE_VERB + '\\s+' + CHANGE_OBJECT + CLAUSE_END, 'i');
const READ_ONLY_REQUEST = /\b(?:read[- ]only\s+(?:task|request|please|review|check|pass)|(?:make|with)\s+no\s+(?:file\s+)?(?:changes|edits)|no\s+file\s+(?:changes|edits))\b/i;

// "If the claim is denied, do not edit anything": a condition, not a rule
// for the whole request.
const CONDITIONAL = /\b(?:if|when|whenever|unless|once|otherwise|before|after|in\s+case|should)\b/i;

const ENGLISH_WORDS = /\b(?:the|and|is|are|to|of|it|you|me|my|please|any|which|what|this|that|with|run|tell)\b/i;

export function forbidsFileChanges(request) {
  const text = String(request || '');
  if (READ_ONLY_REQUEST.test(text)) return true;
  // Other languages (src/multilingual-signals.mjs), unless the request reads
  // as English, where the scoped reading above is the one to trust.
  if (!ENGLISH_WORDS.test(text) && multilingualForbidsChanges(text)) return true;
  const pattern = new RegExp(NO_FILE_CHANGES.source, 'gi');
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(0, match.index);
    const sentence = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1);
    if (!CONDITIONAL.test(sentence)) return true;
  }
  return false;
}

export function forbiddenFileChange(request, name, editingTools) {
  if (!editingTools.has(name) || !forbidsFileChanges(request)) return null;
  return 'Not changed: the user asked you not to change files in this request. Do the rest of the task without editing, then describe any change you would make in your answer; the user will ask if they want it made.';
}
