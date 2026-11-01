// Small models (and sometimes large ones) commit, push, add remotes or rewrite
// global git config when nobody asked. These writes leave the workspace or are
// hard to undo, so they run only when the current request asks for them.
// Opt out with settings.allowUnrequestedGitWrites or
// OASIS_ALLOW_UNREQUESTED_GIT_WRITES=1.

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
