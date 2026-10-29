// Built-in interactive slash commands (Claude Code style). Each handler returns
// { output } text, and optionally { prompt } to send to the agent, or
// { resetSession: true } when the caller should drop the current session.
import { describeHook, runHooks, hasHooks } from './hooks.mjs';
import { compactHistoryIfNeeded, hookOptions } from './agent.mjs';
import { estimateTokens, contextWindowSize } from './context.mjs';
import { loadCustomCommands } from './commands.mjs';
import { loadSettings, PERMISSION_MODES } from './settings.mjs';
import { BUILTIN_AGENTS, loadAgentDefinitions } from './subagents.mjs';
import { memoryFiles } from './memory.mjs';
import { listCheckpoints, rewind } from './checkpoints.mjs';
import { snapshotFile } from './backups.mjs';
import { imageInputCapability } from './images.mjs';
import { listSessions } from './sessions.mjs';
import { resolveWorkspacePath, setAdditionalDirectories } from './tools.mjs';
import { loadOutputStyles, applyOutputStyle } from './output-styles.mjs';
import { lstat, writeFile } from 'node:fs/promises';
import { listWorktrees } from './worktrees.mjs';
import { listAgentTeams } from './agent-tasks.mjs';
import path from 'node:path';

// Claude Code aliases for built-in commands.
export const COMMAND_ALIASES = { keys: 'keybindings', peers: 'list-agents', settings: 'config', checkpoint: 'rewind', continue: 'resume', 'allowed-tools': 'permissions', stats: 'usage', checkup: 'doctor', 'code-review': 'review', bg: 'background', proactive: 'loop', reset: 'clear', new: 'clear', quit: 'exit', routines: 'schedule', feedback: 'bug', share: 'bug', 'install-github-action': 'install-github-app' };

export const BUILTIN_COMMANDS = {
  help: 'Show built-in and custom commands',
  status: 'Show the model provider configuration',
  setup: 'Configure the model provider',
  clear: 'Start a fresh conversation',
  plan: 'Plan a task without writing files or running commands (/plan TASK)',
  fix: 'Reproduce, diagnose, fix, and verify one bug (/fix BUG)',
  diagnose: 'Analyze an error, log, screenshot, or failing output (/diagnose INPUT)',
  rollback: 'Preview and restore the latest file checkpoint (/rollback, then /rollback confirm)',
  compact: 'Summarize the conversation to free context (/compact [focus])',
  context: 'Show how much of the context window is in use',
  cost: 'Show token usage for this session',
  usage: 'Show token usage for this session (same as /cost)',
  effort: 'Show or set reasoning effort for this session (/effort [low|medium|high|max|auto])',
  'install-github-app': 'Set up the Oasis GitHub Action for this repo: writes .github/workflows/oasis.yml (/install-github-app [@trigger] [force] [save])',
  fast: 'Toggle fast mode: faster output on Opus 5.5 / 5 / 4.8 via the Anthropic API, at a higher price (/fast [on|off])',
  model: 'Show or switch the model for this session (/model [id])',
  mode: 'Show or switch the permission mode (/mode ' + PERMISSION_MODES.join('|') + ')',
  permissions: 'Show permission rules, mode, and sandbox',
  agents: 'List available subagents',
  teams: 'List named agent teams and their member status',
  worktrees: 'List subagent worktree branches waiting for review',
  commands: 'List custom slash commands',
  hooks: 'List configured lifecycle hooks',
  bashes: 'List background processes',
  mcp: 'Show connected MCP servers and their tools',
  ide: 'Connect to VS Code / Cursor / Windsurf (selection context, diff review, diagnostics) or show status',
  plugin: 'Manage Claude Code plugins (/plugin [list|install NAME@MARKET|uninstall|enable|disable|update|validate|marketplace add|list|update|remove])',
  'add-dir': 'Add a working directory for this session (/add-dir PATH)',
  'output-style': 'Show or switch the output style (/output-style [default|explanatory|learning|custom])',
  todos: 'Show the current todo list',
  memory: 'Show instruction files and auto memory (/memory search|show|forget|add|path)',
  undo: 'Undo the last turn: restore files and conversation (/undo [N])',
  rewind: 'Undo recent turns: restore files and/or conversation (/rewind [N] [code|chat])',
  review: 'Review changes for correctness bugs (/review [low|medium|high|xhigh|max|ultra] [--fix] [--comment] [--max-findings N|all] [PR#|branch|path])',
  audit: 'Run isolated security, performance, test-coverage, and dependency reviewers, then merge and verify findings (/audit [path-or-scope])',
  tasks: 'List background agents and processes (/tasks, /tasks ID, /tasks stop ID)',
  workflows: 'List workflow runs and saved workflows (/workflows, /workflows ID, stop ID, save ID [--user])',
  commit: 'Commit the current changes with a well-written message (/commit [hint])',
  pr: 'Create a branch if needed, commit, push, and open a pull request (/pr [base])',
  diagnostics: 'Run type checkers and linters, then fix errors (/diagnostics [paths])',
  'security-review': 'Security review of pending changes (/security-review [PR number | git ref])',
  copy: 'Copy the last reply (or the Nth most recent) to the clipboard (/copy [N])',
  fork: 'Fork the conversation: keep the original saved and continue in a copy (alias /branch)',
  branch: 'Fork the conversation (same as /fork)',
  skills: 'List available skills',
  remember: 'Save what is worth keeping from this conversation to auto memory (/remember [focus])',
  loop: 'Run a prompt now and again on an interval until Ctrl+C (/loop [5m] PROMPT); omit the interval to let the model pace itself',
  cd: 'Switch the workspace to another directory and start a fresh conversation (/cd PATH)',
  sandbox: 'Show or change the OS sandbox for this session (/sandbox [on|off|network on|network off])',
  config: 'Settings pane (theme, model, mode, editor, output style, verbose, auto-compact, memory...); /config list | get KEY | set KEY VALUE',
  doctor: 'Check this workspace: tools, language servers, sandbox, settings, provider',
  'release-notes': 'Show recent changes to Oasis',
  export: 'Save this conversation as Markdown (/export [file])',
  resume: 'List saved sessions or resume one (/resume [ID])',
  goal: 'Keep working across turns until a condition is met (/goal CONDITION | clear)',
  color: 'Set this session\'s prompt color (/color red|blue|green|yellow|purple|orange|pink|cyan|random|default)',
  focus: 'Show the last prompt, a one-line summary of each tool call with edit line counts, and the final response',
  background: 'Move this conversation to a background session and free the terminal (/background [one more instruction])',
  debug: 'Turn on debug logging and troubleshoot an issue from the session debug log (/debug [description] | /debug off)',
  'team-onboarding': 'Write a team onboarding guide for this project from your last 30 days of Oasis usage (/team-onboarding [DAYS])',
  heapdump: 'Write a JavaScript heap snapshot and memory breakdown for diagnosing high memory use',
  chrome: 'Turn the Chrome browser tool on or off for this session (/chrome [on|off|status])',
  bug: 'Report a bug: drafts a GitHub issue with your report and environment details (nothing is sent until you open the link) (/bug [report] [--with-transcript])',
  'setup-bedrock': 'Configure Amazon Bedrock: detects AWS credentials, region and model pins, then saves them to user settings (/setup-bedrock [region=R] [profile=P] [model=ID] [sonnet=ID] [haiku=ID] [opus=ID] [save])',
  'setup-vertex': 'Configure Google Vertex AI: detects gcloud project, credentials, region and model pins, then saves them to user settings (/setup-vertex [project=ID] [region=R] [model=ID] [save])',
  'auto-mode-setup': 'Draft autoMode.environment entries (trusted repos, registries, CI, infrastructure) from this project, review them, and save to user settings',
  'autofix-pr': 'Watch the current branch\'s pull request and push fixes for failing CI checks and review comments until it is green (/autofix-pr [extra instructions])',
  login: 'Connect a model provider (runs oasis auth login / setup)',
  logout: 'Remove the stored provider API key',
  'skill-doctor': 'Show each skill\'s context cost and recent usage so you can turn off unused ones (/skill-doctor [DAYS])',
  insights: 'Write an HTML report analyzing your recent sessions on this machine (/insights [DAYS])',
  import: 'Import MCP servers, instructions, commands and rules from Codex, Gemini CLI or Cursor (/import [codex|gemini|cursor] [--dry-run] [--yes])',
  advisor: 'Let the agent consult a second, stronger model mid-task (/advisor MODEL, /advisor off)',
  subtask: 'Run a task in a forked background subagent that inherits this conversation and reports back (/subtask TASK)',
  btw: 'Ask a side question about this session without adding it to the conversation (/btw QUESTION)',
  recap: 'One-line summary of this session',
  rename: 'Name this session (/rename NAME)',
  ultrareview: 'Deep multi-agent code review with independent verification of every finding; alias for /code-review ultra',
  simplify: 'Review changed code for reuse, simplicity, efficiency and abstraction, then apply fixes (/simplify [target])',
  verify: 'Build and run the app to confirm a change really works (/verify [what to check])',
  batch: 'Plan a large change as independent units and run them in parallel worktree subagents (/batch INSTRUCTION)',
  schedule: 'Schedule a prompt in this session (/schedule CRON PROMPT, /schedule list, /schedule delete ID)',
  'fewer-permission-prompts': 'Find safe read-only commands you approve often and add them to the project allowlist',
  keys: 'Show the keyboard shortcut cheat sheet (/keys; alias /keybindings)',
  tips: 'Show a rotating setup and workflow tip (/tips)',
  keybindings: 'Show keyboard shortcuts',
  vim: 'Toggle vim editing for the prompt (/vim on|off)',
  diff: 'Show uncommitted changes in the working tree (/diff [PATH], /diff --stat)',
  autocompact: 'Show or set the auto-compaction threshold (/autocompact 70 = compact at 70% of the window, off, reset)',
  'reload-plugins': 'Reload plugins, skills, agents, hooks and MCP servers without losing the conversation',
  'reload-skills': 'Re-scan skill and command directories without losing the conversation',
  'list-agents': 'List running subagents, agent teams and background processes (alias /peers)',
  statusline: 'Have Oasis set up a status line command for you (/statusline [what to show])',
  'update-config': 'Describe a settings change and have Oasis edit the matching settings.json',
  theme: 'List or switch color themes (/theme NAME, custom:<slug>, plugin:<plugin>:<slug>, auto)',
  'terminal-setup': 'Set up Shift+Enter for newlines in your terminal',
  'privacy-settings': 'Show what Oasis sends where and how to turn things off',
  stop: 'Stop background agents and processes in this session',
  init: 'Inspect this project and create or carefully update OASIS.md',
  exit: 'Leave Oasis'
};

export const SKILL_COMMANDS = Object.freeze({
  init: { skill: 'init', mode: 'workspace-edit', summary: 'Inspect the project and create or update OASIS.md.' },
  plan: { skill: 'plan', mode: 'read-only', summary: 'Inspect relevant code and return an implementation plan without side effects.' },
  fix: { skill: 'debugging', mode: 'workspace-edit', summary: 'Reproduce one bug, apply a focused fix, and verify it.' },
  diagnose: { skill: 'diagnose', mode: 'read-only', summary: 'Analyze supplied evidence and separate confirmed causes from hypotheses.' },
  review: { skill: 'code-review', mode: 'read-only-by-default', summary: 'Review the current diff for correctness, security, performance, accessibility, and test gaps.' },
  rollback: { skill: 'rollback', mode: 'explicit-restore-confirmation', summary: 'Preview and restore the latest tracked file checkpoint after a second-step confirmation.' }
});

function loadSkillInstruction(command) {
  const skill = SKILL_COMMANDS[command] && SKILL_COMMANDS[command].skill;
  if (!skill) throw new Error('No portable skill is registered for /' + command + '.');
  return 'Load the portable ' + skill + ' skill first with load_skill({ name: ' + JSON.stringify(skill) + ' }). ';
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function createUsageTracker() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, turns: 0 };
}

export function recordUsage(tracker, usage = {}) {
  tracker.inputTokens += Number(usage.inputTokens || 0);
  tracker.outputTokens += Number(usage.outputTokens || 0);
  tracker.totalTokens += Number(usage.totalTokens || 0);
  if (usage.phase === undefined) tracker.requests += 1;
}

export async function runBuiltinCommand(name, argument, state) {
  if (Object.hasOwn(COMMAND_ALIASES, name) && !Object.hasOwn(BUILTIN_COMMANDS, name)) name = COMMAND_ALIASES[name];
  const { root, session, env = process.env, usage, sessionOptions = {} } = state;
  if (!state.sessionOptions) state.sessionOptions = sessionOptions;
  switch (name) {
    case 'help': {
      const custom = await loadCustomCommands(root, { env }).catch(() => new Map());
      // Keep the six deliberate core workflows first; the full command set remains
      // available below, grouped by purpose, without creating a second palette system.
      const groups = [
        { title: 'Core workflows', commands: ['init', 'plan', 'fix', 'diagnose', 'review', 'rollback'] },
        { title: 'Getting started', commands: ['help', 'setup', 'status', 'doctor', 'context', 'cost', 'undo'] },
        { title: 'Working', commands: ['clear', 'compact', 'diagnostics', 'tasks', 'workflows', 'commit', 'pr', 'goal', 'batch', 'simplify', 'verify', 'todos', 'agents', 'teams', 'worktrees', 'resume', 'fork', 'copy', 'export'] },
        { title: 'Safety', commands: ['permissions', 'mode', 'sandbox', 'security-review', 'undo', 'rewind', 'purge', 'logout', 'doctor'] },
        { title: 'Settings', commands: ['model', 'effort', 'config', 'output-style', 'fast', 'color', 'add-dir', 'login', 'logout', 'auto-mode-setup', 'chrome'] }
      ];
      const used = new Set();
      const lines = [];
      for (const group of groups) {
        const entries = group.commands
          .filter((command) => Object.hasOwn(BUILTIN_COMMANDS, command) && !used.has(command))
          .map((command) => [command, BUILTIN_COMMANDS[command]]);
        if (!entries.length) continue;
        lines.push(group.title + ':');
        for (const [command, description] of entries) {
          lines.push('  /' + command.padEnd(18) + ' ' + description);
          used.add(command);
        }
      }
      const rest = Object.entries(BUILTIN_COMMANDS).filter(([command]) => !used.has(command));
      if (rest.length) {
        lines.push('More commands:');
        for (const [command, description] of rest) lines.push('  /' + command.padEnd(18) + ' ' + description);
      }
      if (custom.size) {
        lines.push('Custom commands:');
        for (const command of custom.values()) lines.push('  /' + (command.name + (command.argumentHint ? ' ' + command.argumentHint : '')).padEnd(18) + ' ' + command.description + ' (' + command.scope + ')');
      }
      lines.push('Tips: mention files with @path, start a line with # to save a project memory, and say "install pnpm" for direct installs.');
      return { output: lines.join('\n') };
    }
    case 'init': {
      const focus = String(argument || '').trim();
      return {
        output: 'Preview: inspect project structure, documentation, scripts, tests, and existing instructions; then create or carefully merge OASIS.md. No file changes occur until the agent proposes a change through the existing workspace tools and approvals.',
        prompt: loadSkillInstruction('init') + 'Inspect this workspace read-only and use source files and scripts as evidence. Create or carefully update OASIS.md with project purpose, architecture and key paths, setup and verification commands, conventions, and safety constraints. Preserve useful existing human-authored guidance. Do not guess facts, copy secrets, install anything, or bypass existing approval, snapshot, or file-state protections. Use normal workspace tools and approval prompts before changing files. ' + (focus ? 'User focus: ' + focus : 'Use the project itself to determine the most useful guide content.')
      };
    }
    case 'plan': {
      if (!String(argument || '').trim()) return { output: 'Usage: /plan Describe the task to plan. This command is read-only and will not edit files or run project commands.' };
      return {
        output: 'Preview: inspect relevant source and tests, then return an ordered implementation plan with file targets, risks, and verification steps. No files, installs, or project commands will be changed or run.',
        prompt: loadSkillInstruction('plan') + 'Create an implementation plan for the following task. Inspect project instructions, source, call sites, and tests using read-only tools only. Do not edit files, install packages, make network requests, or run project commands. Return ordered steps, likely files, acceptance criteria, risks, unknowns, and verification for each step. Task: ' + String(argument).trim(),
        planOnly: true
      };
    }
    case 'fix': {
      if (!String(argument || '').trim()) return { output: 'Usage: /fix Describe the bug or provide its error/reproduction steps. Nothing has been changed.' };
      return {
        output: 'Preview: inspect the bug, reproduce it where possible, add a focused regression test, make the smallest correct fix, and rerun relevant checks. File edits, commands, installs, and network actions remain subject to existing OASIS approvals and snapshots.',
        prompt: loadSkillInstruction('fix') + 'Reproduce and fix only the reported bug: ' + String(argument).trim() + '\n\nInspect first, distinguish evidence from hypotheses, add a regression test where practical, use minimal edits, and verify with relevant tests. Use OASIS tools so normal approval, workspace validation, snapshots, and stale-file checks apply. Do not install dependencies, access the network, or change unrelated files without separate approval. After each source edit, inspect the automatic lspVerification result or run the lsp diagnostics operation. Treat LSP status unavailable and any new or unclassified diagnostic error as a blocker; fix and recheck. Do not claim /fix succeeded while the LSP gate is blocked, and report verification as unavailable when diagnostics cannot be collected. Report exact checks and results; never claim an unrun test passed.'
      };
    }
    case 'diagnose': {
      if (!String(argument || '').trim()) return { output: 'Usage: /diagnose Paste an error/log/output or provide a file path and observed failure. For screenshots, attach the image or provide its path. Nothing has been changed.' };
      const capability = imageInputCapability(session && session.config || {}, env);
      const imageMentioned = /(?:screenshot|image|picture|photo|\.(?:png|jpe?g|gif|webp)\b|@[^\s]+\.(?:png|jpe?g|gif|webp)\b)/i.test(String(argument));
      const imageNote = imageMentioned
        ? '\nImage capability preflight: ' + capability.status.toUpperCase() + ' — ' + capability.reason + ' Do not claim visual analysis unless image data is actually attached and the active model accepts it.'
        : '';
      return {
        output: 'Preview: analyze the supplied evidence, trace likely causes, and identify the next useful diagnostic step. This is read-only; it will not attempt a fix.' + (imageMentioned ? '\nImage input status: ' + capability.status + '. ' + capability.reason : ''),
        prompt: loadSkillInstruction('diagnose') + 'Diagnose the following evidence without modifying files. Separate observed facts, confirmed causes, likely explanations, and untested hypotheses. If information is missing, ask for the most useful next item. Never claim to have viewed a screenshot unless its image data was attached and the selected model can analyze images; if image support is unsupported or unknown, say so plainly and request text or a capable model. Redact secrets from logs. Do not edit files, install software, make network requests, or execute commands unless separately asked and permitted.\n\nEvidence supplied by the user: ' + String(argument).trim() + imageNote
      };
    }
    case 'rollback': {
      if (!session || !session.checkpoints || !session.checkpoints.turns.length) {
        if (session) session.pendingSkillRollback = null;
        return { output: 'No file checkpoint is available in this session. No files were changed. /rollback only restores OASIS-tracked file changes; it cannot reverse shell-command side effects, installs, network activity, or changes outside the checkpoint system.' };
      }
      const currentTurn = session.checkpoints.turns.at(-1);
      const currentFiles = [...currentTurn.files.keys()].sort();
      const confirmWord = String(argument || '').trim().toLowerCase();
      if (!confirmWord) {
        if (!currentFiles.length) return { output: 'The latest checkpoint has no tracked file changes to restore. No files were changed.' };
        session.pendingSkillRollback = { createdAt: currentTurn.createdAt, prompt: currentTurn.prompt, files: currentFiles };
        return { output: [
          'ROLLBACK PREVIEW — no files have changed.',
          'Checkpoint task: ' + String(currentTurn.prompt || '(no task label)').slice(0, 200),
          'Files affected (' + currentFiles.length + '):',
          ...currentFiles.map((file) => '  • ' + file),
          '',
          'Before restoring, OASIS will preserve the current contents of eligible files in its local recovery-backup store.',
          'Type /rollback confirm to apply this exact preview. A changed checkpoint requires a new preview.',
          'Limit: shell-command side effects, dependency installs, network operations, and untracked external changes are not reversed.'
        ].join('\n') };
      }
      if (confirmWord !== 'confirm') return { output: 'Usage: /rollback to preview the latest checkpoint, then /rollback confirm to restore it. No files were changed.' };
      const pending = session.pendingSkillRollback;
      if (!pending || pending.createdAt !== currentTurn.createdAt || pending.prompt !== currentTurn.prompt || pending.files.join('\0') !== currentFiles.join('\0')) {
        session.pendingSkillRollback = null;
        return { output: 'The preview is missing or the latest checkpoint changed. No files were changed; run /rollback to preview again.' };
      }
      const recovery = [];
      for (const [relative, entry] of currentTurn.files) {
        if (entry.skipped) continue;
        const target = await resolveWorkspacePath(root, relative, { rejectSymlinks: true });
        let info;
        try { info = await lstat(target.absolute); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing rollback because ' + relative + ' is not a safe regular file. No checkpoint restoration was started.');
        recovery.push(await snapshotFile(root, target.absolute, 'before-skill-rollback', { env }));
      }
      const result = await rewind(session, 1, 'code');
      session.pendingSkillRollback = null;
      if (!result.skipped.length && result.turns > 0) {
        const consumed = session.checkpoints.turns.pop();
        if (consumed) for (const entry of consumed.files.values()) session.checkpoints.bytes = Math.max(0, session.checkpoints.bytes - (entry.content ? entry.content.length : 0));
      }
      const lines = ['Rollback ' + (result.skipped.length ? 'partially completed' : 'completed') + '.'];
      lines.push('  Restored: ' + (result.restored.length ? result.restored.join(', ') : '(none)'));
      if (result.deleted.length) lines.push('  Removed new files: ' + result.deleted.join(', '));
      if (result.skipped.length) lines.push('  Skipped: ' + result.skipped.join(', '), '  The checkpoint remains available for another attempt.');
      lines.push('  Recovery copies: ' + (recovery.length ? recovery.map((item) => item.relativePath + ' [' + item.id + ']').join(', ') : '(no current file contents needed backing up)'));
      lines.push('  Conversation history was not rewound.');
      lines.push('  Shell-command side effects, installs, network activity, and changes not captured by file tools were not reversed.');
      return { output: lines.join('\n'), rollback: { restored: result.restored, deleted: result.deleted, skipped: result.skipped, recovery } };
    }
    case 'commands': {
      const custom = await loadCustomCommands(root, { env });
      if (!custom.size) return { output: 'No custom commands yet. Add Markdown files to .oasis/commands/ or .claude/commands/ (for example .oasis/commands/review.md becomes /review).' };
      return { output: [...custom.values()].map((command) => '/' + command.name + (command.argumentHint ? ' ' + command.argumentHint : '') + '  ' + command.description + '  [' + command.file + ']').join('\n') };
    }
    case 'compact': {
      if (!session || session.messages.length <= 1) return { output: 'Nothing to compact yet.' };
      const before = estimateTokens(session.messages);
      const result = await compactHistoryIfNeeded(session, { force: true, instructions: argument });
      const after = estimateTokens(session.messages);
      if (usage && result.tokensUsed) recordUsage(usage, { totalTokens: result.tokensUsed, phase: 'compaction' });
      if (result.blockedByHook) return { output: 'A PreCompact hook cancelled /compact: ' + (result.reason || 'no reason given') };
      return { output: result.compacted ? 'Conversation compacted: about ' + formatNumber(before) + ' -> ' + formatNumber(after) + ' tokens.' : 'Nothing to compact yet.' };
    }
    case 'context': {
      if (!session) return { output: 'No conversation yet. Context in use: system prompt only.' };
      const conversationTokens = estimateTokens(session.messages);
      const windowSize = contextWindowSize(session.config, env);
      const system = estimateTokens([session.messages[0]]);
      const definitions = session.toolDefinitions || [];
      const mcpNames = session.mcpToolMap instanceof Map ? new Set(session.mcpToolMap.keys()) : new Set();
      const mcpDefinitions = definitions.filter((item) => item && item.function && mcpNames.has(item.function.name));
      const localDefinitions = definitions.filter((item) => !item || !item.function || !mcpNames.has(item.function.name));
      const localTools = Math.round(JSON.stringify(localDefinitions).length / 4);
      const mcpTools = Math.round(JSON.stringify(mcpDefinitions).length / 4);
      const startup = system + localTools + mcpTools;
      // Tool schemas are sent with requests but are not represented in session.messages.
      // Include them in the displayed context estimate so a tool-heavy setup is visible.
      const used = conversationTokens + localTools + mcpTools;
      const percent = windowSize ? Math.round(used / windowSize * 100) : 0;
      const bar = '#'.repeat(Math.min(30, Math.round(percent * 0.3))).padEnd(30, '.');
      return { output: [
        'Estimated context: [' + bar + '] ' + percent + '% of ' + formatNumber(windowSize) + ' tokens',
        '  Startup before chat: ~' + formatNumber(startup) + ' tokens',
        '  System prompt, project instructions and memory: ~' + formatNumber(system),
        '  Built-in tools (' + localDefinitions.length + '): ~' + formatNumber(localTools),
        '  MCP tools (' + mcpDefinitions.length + '): ~' + formatNumber(mcpTools),
        '  Conversation (' + (session.messages.length - 1) + ' messages): ~' + formatNumber(Math.max(0, conversationTokens - system)),
        ...(startup > 15000 ? ['Warning: startup context is over 15,000 tokens before your messages. Disconnect unused tools or trim long project instructions.'] : []),
        'These are estimates. Tool schemas and hidden provider metadata can change the real count.',
        'Oasis compacts automatically at about 60% of the window. Override the window with contextWindow in the provider config or OASIS_CONTEXT_WINDOW. Use /compact to summarize now.'
      ].join('\n') };
    }
    case 'teams': {
      if (!session) return { output: 'Start a session first; named agent teams are session-local.' };
      const teams = listAgentTeams(session);
      if (!teams.length) return { output: 'No named agent teams. Use team_create to create a team, then launch workers with team_id.' };
      return { output: ['Agent teams:', ...teams.map((team) => '  ' + team.id + '  ' + team.name + '  ' + team.status + '  ' + team.running + '/' + team.member_count + ' running' + (team.description ? '\n    ' + team.description : '') + (team.members.length ? '\n' + team.members.map((member) => '    ' + member.id + '  ' + member.status + '  ' + member.description).join('\n') : ''))].join('\n') };
    }
    case 'worktrees': {
      const items = await listWorktrees(root, { env });
      if (!items.length) return { output: 'No subagent worktrees. Ask for parallel work with isolation "worktree" to get one branch per agent.' };
      return { output: ['Subagent worktrees:', ...items.map((item) => '  ' + (item.branch || '(detached)').padEnd(36) + ' ' + item.relative), 'Review: use worktree_inspect with { branch: "BRANCH" } to preview changes and conflicts. Integrate: use worktree_merge after review (approval required; predicted conflicts are blocked). Remove: git worktree remove PATH && git branch -D BRANCH'].join('\n') };
    }
    case 'commit': {
      return { prompt: 'Commit my current changes. First read git_status, git_diff, and git_log (limit 10) to understand the changes and the message style. Leave out files that should not be committed (build output, secrets, unrelated scratch files) and tell me about them. Then call git_commit with a concise message: a summary line under 72 characters, then a short body explaining why.' + (argument ? ' Extra guidance for the message: ' + argument : '') + ' If a hook rejects the commit, fix the problem and try again; do not skip hooks.' };
    }
    case 'pr': {
      return { prompt: 'Open a pull request for my work' + (argument ? ' into ' + argument : '') + '. Steps: 1) read git_status, git_diff, and git_log; 2) if I am on the default branch, create a descriptive feature branch with git_branch; 3) if there are uncommitted changes that belong in this PR, commit them with git_commit; 4) call create_pull_request' + (argument ? ' with base ' + JSON.stringify(argument) : '') + ' with a short title and a body containing "## Summary" (bullet points) and "## Test plan" (what was run or should be checked). Reply with the PR URL.' };
    }
    case 'diagnostics': {
      const targets = argument ? argument.split(/\s+/).filter(Boolean) : [];
      return { prompt: 'Run the diagnostics tool' + (targets.length ? ' with paths ' + JSON.stringify(targets) : '') + '. Report the problems grouped by file. If there are errors, fix them with minimal edits, then run diagnostics again until it reports no errors or the remaining ones need my decision. Do not silence checks with ignore comments or config changes unless I ask.' };
    }
    case 'cost': {
      const u = usage || createUsageTracker();
      const spent = session && typeof session.costUsd === 'number' ? session.costUsd : (u.costUsd || 0);
      const { formatUsd, priceFor } = await import('./pricing.mjs');
      const model = session && session.config && session.config.model || '';
      const priced = priceFor(model, { config: session && session.config || {}, overrides: session && session.pricing || {} });
      const money = priced ? ' Estimated cost: ' + formatUsd(spent) + (priced.local ? ' (local model)' : '') + (session && session.maxBudgetUsd ? ' of a ' + formatUsd(session.maxBudgetUsd) + ' budget' : '') + '.' : ' Cost: unknown for ' + (model || 'this model') + ' (add "pricing" in settings to estimate).';
      return { output: 'Session usage: ' + formatNumber(u.totalTokens) + ' tokens (' + formatNumber(u.inputTokens) + ' input, ' + formatNumber(u.outputTokens) + ' output) across ' + u.requests + ' model requests and ' + u.turns + ' turns.' + money };
    }
    case 'model': {
      if (!argument) return { output: 'Model: ' + (session ? session.config.model : '(provider default; start a task first)') + '. Use /model MODEL_ID or an alias (opus, sonnet, haiku, fable, best, opusplan) to switch for this session, /model default to reset.' };
      // PreModelSwitch hooks can allow, deny, or ask; PostModelSwitch adds context for the next request.
      if (session && session.availableModels) {
        const { modelAllowed, modelRestrictionMessage } = await import('./model-aliases.mjs');
        if (!modelAllowed(argument, session.availableModels, { env: session.modelEnv, protocol: session.config.protocol })) return { output: modelRestrictionMessage(argument, session.availableModels) };
      }
      const previous = session ? session.config.model : null;
      if (session && hasHooks(session.hooks, 'PreModelSwitch')) {
        const pre = await runHooks('PreModelSwitch', { session_id: session.sessionId || 'unsaved', model: argument, previous_model: previous, source: 'slash_command' }, hookOptions(session, env));
        if (pre.blocked || pre.permissionDecision === 'deny') return { output: 'A PreModelSwitch hook blocked switching to ' + argument + ': ' + (pre.reason || 'no reason given') };
        if (pre.permissionDecision === 'ask' && typeof state.confirm === 'function' && !(await state.confirm('A hook asks you to confirm switching to ' + argument + '. Switch?'))) return { output: 'Model switch cancelled.' };
      }
      if (argument.toLowerCase() === 'default' && session && session.initialModel && session.initialModel !== 'default') {
        sessionOptions.model = null;
        session.config = { ...session.config, model: session.initialModel };
        return { output: 'Model reset to the configured default, ' + session.initialModel + '.' };
      }
      sessionOptions.model = argument;
      if (session) session.config = { ...session.config, model: argument };
      if (session && hasHooks(session.hooks, 'PostModelSwitch')) {
        const post = await runHooks('PostModelSwitch', { session_id: session.sessionId || 'unsaved', model: argument, previous_model: previous, source: 'slash_command' }, hookOptions(session, env)).catch(() => null);
        if (post && post.additionalContext.length) (session.asyncHookFeedback ||= []).push('PostModelSwitch hook: ' + post.additionalContext.join('\n'));
      }
      return { output: 'Model for this session set to ' + argument + '.' };
    }
    case 'mode': {
      const current = session ? session.permissions.mode : (sessionOptions.permissionMode || 'default');
      if (!argument || argument === 'log') {
        const state = session && session.autoMode;
        const log = state && state.log.length ? '\nRecent auto mode decisions:\n' + state.log.slice(-10).map((item) => '  ' + item.decision + ' ' + item.tool + (item.reason ? ': ' + item.reason : '')).join('\n') : '';
        return { output: 'Permission mode: ' + current + '. Options: ' + PERMISSION_MODES.join(', ') + '.' + log };
      }
      if (!PERMISSION_MODES.includes(argument)) return { output: 'Unknown mode. Options: ' + PERMISSION_MODES.join(', ') + '.' };
      if (argument === 'bypassPermissions' && (sessionOptions.disableBypass || (session && session.settings && session.settings.permissions && session.settings.permissions.disableBypassPermissionsMode))) return { output: 'bypassPermissions mode is disabled by settings (permissions.disableBypassPermissionsMode).' };
      sessionOptions.permissionMode = argument;
      if (session) {
        if (argument === 'plan' && session.permissions.mode !== 'plan') session.prePlanMode = session.permissions.mode;
        session.permissions.setMode(argument);
      }
      if (argument === 'auto' && session && session.autoMode) { session.autoMode.blockedInRow = 0; session.autoMode.blockedTotal = 0; }
      return { output: 'Permission mode set to ' + argument + '.' + (argument === 'auto' ? ' A classifier model now approves routine actions and blocks risky ones; anything unclear still comes to you. /mode log shows its decisions.' : '') };
    }
    case 'permissions': {
      const described = session ? session.permissions.describe() : null;
      const settings = await loadSettings(root, { env });
      const view = described || { mode: sessionOptions.permissionMode || settings.permissions.defaultMode, allow: settings.permissions.allow, ask: settings.permissions.ask, deny: settings.permissions.deny, session: [] };
      const lines = ['Mode: ' + view.mode + '   Workspace trusted: ' + (settings.trusted ? 'yes' : 'no (run oasis trust)')];
      for (const kind of ['allow', 'ask', 'deny', 'session']) lines.push('  ' + kind.padEnd(8) + (view[kind].length ? view[kind].join(', ') : '(none)'));
      if (session && session.sandbox) lines.push('Sandbox: ' + (session.sandbox.enabled ? (session.sandbox.available ? session.sandbox.kind + (session.sandbox.network ? ', network on' : ', network off') : 'unavailable - ' + session.sandbox.reason) : 'off'));
      lines.push('Add rules with: oasis permissions add allow "Bash(npm test:*)"');
      return { output: lines.join('\n') };
    }
    case 'agents': {
      const agents = session && session.agents || await loadAgentDefinitions(root, { env }).catch(() => ({ ...BUILTIN_AGENTS }));
      return { output: Object.values(agents).map((agent) => agent.name + ' [' + agent.source + ']' + (agent.tools ? ' tools: ' + agent.tools.join(', ') : '') + '\n    ' + agent.description).join('\n') + '\nAdd your own in .oasis/agents/NAME.md or .claude/agents/NAME.md.' };
    }
    case 'hooks': {
      const hooks = session ? session.hooks : (await loadSettings(root, { env })).hooks;
      const entries = Object.entries(hooks || {});
      if (!entries.length) return { output: 'No hooks configured. Add them under "hooks" in .oasis/settings.json or .claude/settings.json.' };
      const lines = [];
      for (const [event, groups] of entries) for (const group of groups) for (const hook of group.hooks) lines.push(event + (group.matcher ? ' [' + group.matcher + ']' : '') + ': ' + describeHook(hook));
      return { output: lines.join('\n') };
    }
    case 'output-style': {
      const styles = await loadOutputStyles(root, { env });
      const current = session && session.outputStyle || sessionOptions.outputStyle || 'default';
      if (!argument) return { output: ['Output styles (current: ' + current + '):', ...Object.values(styles).map((style) => (style.name === current ? '* ' : '  ') + style.name.padEnd(14) + ' ' + style.description + ' [' + style.source + ']'), 'Switch with /output-style NAME. Make it the default with "outputStyle" in .oasis/settings.json. Add your own in .oasis/output-styles/NAME.md.'].join('\n') };
      const style = styles[argument.toLowerCase()];
      if (!style) return { output: 'Unknown output style ' + argument + '. Run /output-style to list them.' };
      sessionOptions.outputStyle = style.name;
      if (session) applyOutputStyle(session, style);
      return { output: 'Output style set to ' + style.name + '.' };
    }
    case 'add-dir': {
      if (!argument) {
        const dirs = session && session.additionalDirectories || [];
        return { output: dirs.length ? 'Additional directories:\n' + dirs.map((dir) => '  ' + dir).join('\n') : 'No additional directories. Add one with /add-dir PATH.' };
      }
      const wanted = [...(session && session.additionalDirectories || []), path.resolve(root, argument)];
      const result = await setAdditionalDirectories(root, wanted);
      if (result.rejected.length) return { output: 'Could not add ' + argument + ': ' + result.rejected[0].error + '.' };
      sessionOptions.addDirs = [...new Set([...(sessionOptions.addDirs || []), ...result.accepted])];
      if (session) {
        session.additionalDirectories = result.accepted;
        if (session.sandbox && Array.isArray(session.sandbox.writable)) session.sandbox.writable = [root, ...result.accepted];
        const note = '\n\nAdditional working directory added: ' + result.accepted.at(-1) + ' (you may read and edit files there).';
        session.baseSystemPrompt = (session.baseSystemPrompt || session.messages[0].content) + note;
        if (session.messages[0] && session.messages[0].role === 'system') session.messages[0].content += note;
      }
      if (session && hasHooks(session.hooks, 'DirectoryAdded')) {
        // The directory is already added; the hook's systemMessage becomes context next turn.
        runHooks('DirectoryAdded', { session_id: session.sessionId || 'unsaved', directory: result.accepted.at(-1), source: 'slash_command' }, hookOptions(session, env))
          .then((added) => { const notes = [...added.messages, ...added.additionalContext]; if (notes.length) (session.asyncHookFeedback ||= []).push('DirectoryAdded hook: ' + notes.join('\n')); }).catch(() => {});
      }
      return { output: 'Added ' + result.accepted.at(-1) + ' for this session.' };
    }
    case 'ide': {
      const { discoverIde, attachIde, listIdeLocks } = await import('./ide.mjs');
      if (session && session.ide && argument.trim() !== 'reconnect') return { output: 'Connected to ' + session.ide.ideName + ' (port ' + session.ide.port + '). Selections are shared with each prompt; edit approvals open as diffs there.' };
      const client = await discoverIde(root, env);
      if (client && session) { attachIde(session, client); return { output: 'Connected to ' + client.ideName + '. Selections are now shared and edit approvals open as diffs in the IDE.' }; }
      if (client) return { output: client.ideName + ' is available; it connects when the session starts.' };
      const locks = await listIdeLocks(env);
      return { output: 'No IDE bridge found for this folder.' + (locks.length ? ' Running bridges: ' + locks.map((lock) => (lock.ideName || 'IDE') + ' [' + (lock.workspaceFolders || []).join(', ') + ']').join('; ') + '.' : '') + ' Install the extension with: oasis ide install, then open this folder in VS Code.' };
    }
    case 'plugin':
    case 'plugins': {
      const { pluginCli } = await import('./claude-plugins.mjs');
      let text = '';
      const args = argument.trim() ? argument.trim().split(/\s+/) : ['list'];
      await pluginCli(root, args, { env, write: (chunk) => { text += chunk; } });
      return { output: text.trim() + (/^(install|i|uninstall|remove|enable|disable|update)$/.test(args[0]) ? '\nRun /clear or start a new session to load the change.' : '') };
    }
    case 'mcp': {
      const login = argument.match(/^(login|logout)\s+([A-Za-z0-9_-]+)$/i);
      if (login && login[1].toLowerCase() === 'login') return { output: 'Starting sign-in for ' + login[2] + '.', mcpLogin: login[2] };
      if (login) {
        const { mcpLogout } = await import('./mcp-auth-commands.mjs');
        return { output: await mcpLogout(root, login[2], { env }) };
      }
      const clients = session && session.mcpClients ? [...session.mcpClients.entries()] : [];
      const failures = session && session.mcpFailures || [];
      const lines = [];
      for (const [name, client] of clients) {
        lines.push(name + ' [' + (client.source || 'user') + ', ' + (client.config && client.config.type === 'http' ? 'http' : 'stdio') + '] ' + (client.tools || []).length + ' tool(s): ' + (client.tools || []).map((tool) => tool.name).join(', '));
        const resources = (client.resources || []).length + (client.resourceTemplates || []).length;
        if (resources) lines.push('    resources: ' + resources + ' (mention one as @' + name + ':URI, e.g. @' + name + ':' + ((client.resources || [])[0] || { uri: 'URI' }).uri + ')');
        for (const prompt of client.prompts || []) lines.push('    /mcp__' + name + '__' + prompt.name + (prompt.arguments && prompt.arguments.length ? ' ' + prompt.arguments.map((arg) => arg.required ? '<' + arg.name + '>' : '[' + arg.name + ']').join(' ') : '') + (prompt.description ? '  ' + String(prompt.description).slice(0, 120) : ''));
      }
      for (const failure of failures) lines.push(failure.name + ' - not connected: ' + failure.error);
      if (session && session.mcpConnecting) lines.push('(more servers still connecting in the background; MCP_CONNECTION_NONBLOCKING is on)');
      if (!lines.length) return { output: 'No MCP servers connected. Add user servers with oasis mcp add, or project servers in .mcp.json.' };
      return { output: lines.join('\n') };
    }
    case 'audit': {
      const scope = String(argument || '.').trim() || '.';
      return {
        output: 'Starting the bounded read-only audit workflow. Reviewers run in isolated contexts; the final report separates verified and unverified findings. Scope: ' + scope,
        prompt: [
          'Run the built-in workflow named "audit" through the workflow tool, with action "run", name "audit", and args set to ' + JSON.stringify(scope) + '.',
          'Do not replace the workflow with a single-agent review. The workflow runs security, performance, test-coverage, and dependency reviewers in isolated read-only contexts, deduplicates findings, verifies up to four high/critical findings, and bounds the final report.',
          'Render only the merged report returned by the workflow. Keep verified and unverified findings separate, sort by severity then confidence, include path/line evidence and a concrete fix, and report any failed reviewer as partial coverage. Never present an unverified finding as confirmed.'
        ].join('\n')
      };
    }
    case 'ultrareview':
      if (session) session.reportedFindings = undefined;
      return { output: 'Starting a deep code review of ' + describeReviewTarget('ultra ' + argument) + '.', prompt: reviewPrompt('review', 'ultra ' + argument) };
    case 'review':
    case 'security-review': {
      const custom = await loadCustomCommands(root, { env }).catch(() => new Map());
      if (custom.has(name)) return null; // A project or user command with this name wins.
      if (session) session.reportedFindings = undefined; // Each review reports its own findings.
      return { output: 'Preview: ' + (name === 'review' ? 'review the diff for correctness, security, performance, accessibility, and regression-test gaps' : 'review pending changes for security risks') + '. ' + (name === 'review' && !parseReviewArgs(argument).fix ? 'Read-only; no files will be changed.' : name === 'review' ? 'The explicit --fix option allows focused corrections after findings are reported.' : 'Read-only; no files will be changed.') + ' Target: ' + describeReviewTarget(argument) + '.', prompt: reviewPrompt(name, argument) };
    }
    case 'export': {
      if (!session || session.messages.length <= 1) return { output: 'Nothing to export yet.' };
      const target = path.resolve(root, argument || 'oasis-conversation-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md');
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return { output: 'Export path must be inside the workspace.' };
      await writeFile(target, conversationMarkdown(session), { flag: 'wx' }).catch((error) => {
        if (error.code === 'EEXIST') throw new Error(relative + ' already exists; choose another file name.');
        throw error;
      });
      return { output: 'Exported ' + (session.messages.length - 1) + ' messages to ' + relative + '.' };
    }
    case 'resume': {
      const saved = await listSessions(root, { env });
      if (!argument) {
        if (!saved.length) return { output: 'No saved sessions for this workspace. Start Oasis with --save (or --continue) to keep conversations.' };
        return { output: ['Saved sessions (newest first):', ...saved.slice(0, 15).map((item, index) => '  ' + (index + 1) + '. ' + item.id + '  ' + item.updatedAt + '  ' + item.messages + ' messages' + (item.model ? '  ' + item.model : '')), 'Resume with /resume ID or /resume NUMBER.'].join('\n') };
      }
      // Ids may start with digits, so prefer an id match before treating the argument as a list number.
      const pick = saved.find((item) => item.id === argument) || (/^\d{1,3}$/.test(argument) ? saved[Number(argument) - 1] : null) || saved.find((item) => item.id.startsWith(argument));
      if (!pick) return { output: 'No saved session matches ' + argument + '. Run /resume to list them.' };
      return { output: 'Resuming session ' + pick.id + ' on your next message.', resume: pick.id };
    }
    case 'usage':
      return await runBuiltinCommand('cost', argument, state);
    case 'undo':
      return await runBuiltinCommand('rewind', argument || '1', state);
    case 'branch':
      return await runBuiltinCommand('fork', argument, state);
    case 'install-github-app': {
      const install = await import('./github-install.mjs');
      const words = String(argument || '').split(/\s+/).filter(Boolean);
      const trigger = words.find((word) => word.startsWith('@'));
      const plan = await install.githubInstallPlan(root, session ? session.config : {}, { trigger });
      const text = install.describeInstallPlan(plan);
      if (plan.exists && !words.includes('force')) return { output: text + '\nNothing written. Run /install-github-app force to replace the existing workflow.' };
      const confirmed = words.includes('save') || words.includes('force') || (typeof state.confirm === 'function' && await state.confirm(text + '\nWrite the workflow file?'));
      if (!confirmed) return { output: text + '\nNothing written. Run /install-github-app save to write it.' };
      return { output: text + '\n' + await install.writeInstallPlan(plan) };
    }
    case 'fast': {
      const { fastModeRequest } = await import('./model-aliases.mjs');
      const current = Boolean(session && session.fastMode);
      const want = !argument ? !current : /^(on|true|1|yes)$/i.test(argument) ? true : /^(off|false|0|no)$/i.test(argument) ? false : null;
      if (want === null) return { output: 'Usage: /fast [on|off]' };
      if (want && /^(1|true)$/i.test(String((env || process.env).CLAUDE_CODE_DISABLE_FAST_MODE || ''))) return { output: 'Fast mode is disabled by CLAUDE_CODE_DISABLE_FAST_MODE.' };
      if (session) session.fastMode = want;
      const { updateUserSettings } = await import('./settings.mjs');
      await updateUserSettings((settings) => { if (want) settings.fastMode = true; else delete settings.fastMode; return settings; }, env || process.env).catch(() => {});
      if (!want) return { output: 'Fast mode off.' };
      const config = session && session.config;
      const anthropic = config && config.protocol === 'anthropic';
      const supported = config && fastModeRequest(config.model);
      return { output: 'Fast mode on' + (anthropic && supported ? ' for ' + config.model + '. Output is faster and billed at the higher fast-mode rate.' : '. It takes effect only with the Anthropic API on Opus 5.5, Opus 5 or Opus 4.8' + (config ? ' (current: ' + config.protocol + ' / ' + config.model + ')' : '') + '; switch with /model opus.') };
    }
    case 'effort': {
      const { EFFORT_LEVELS, applyEffort } = await import('./agent.mjs');
      const current = sessionOptions.effort || 'auto';
      if (!argument) return { output: 'Reasoning effort: ' + current + '. Options: ' + EFFORT_LEVELS.join(', ') + '. auto picks from your prompt ("think hard", "ultrathink").' };
      const level = argument.toLowerCase();
      if (!EFFORT_LEVELS.includes(level)) return { output: 'Unknown effort level. Options: ' + EFFORT_LEVELS.join(', ') + '.' };
      sessionOptions.effort = level === 'auto' ? null : level;
      if (session) session.config = applyEffort(session.config, sessionOptions.effort, session.baseEffortConfig || (session.baseEffortConfig = { reasoningEffort: session.config.reasoningEffort, thinkingBudget: session.config.thinkingBudget }));
      return { output: 'Reasoning effort set to ' + level + ' for this session.' };
    }
    case 'copy': {
      const replies = session ? session.messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) : [];
      const n = Math.max(1, Number.parseInt(argument, 10) || 1);
      const reply = replies[replies.length - n];
      if (!reply) return { output: 'There is no reply to copy yet.' };
      const text = reply.content.trim();
      const { copyToClipboard } = await import('./clipboard.mjs');
      const result = await copyToClipboard(text, { env });
      return { output: result.ok ? 'Copied ' + text.length + ' characters to the clipboard' + (result.method ? ' (' + result.method + ')' : '') + '.' : 'No clipboard program found (pbcopy, wl-copy, xclip, xsel, clip). Sent it through the terminal (OSC 52) instead.', ...(result.ok ? {} : { osc52: Buffer.from(text, 'utf8').toString('base64') }) };
    }
    case 'fork': {
      if (!session || session.messages.length <= 1) return { output: 'Nothing to fork yet.' };
      const { saveSession } = await import('./sessions.mjs');
      const { randomUUID } = await import('node:crypto');
      const original = await saveSession(session, { env });
      session.sessionId = randomUUID();
      const copy = await saveSession(session, { env });
      return { output: 'Forked the conversation. The original is saved as ' + original.id + ' (/resume ' + original.id + ' to go back); you are now in ' + copy.id + '.', forked: { from: original.id, to: copy.id } };
    }
    case 'skills': {
      const { listAvailableSkills } = await import('./tools.mjs');
      const skills = await listAvailableSkills(root, { env }).catch(() => []);
      if (!skills.length) return { output: 'No skills found. Add one at .oasis/skills/NAME/SKILL.md (or .claude/skills/NAME/SKILL.md) with name and description front matter.' };
      return { output: skills.map((skill) => skill.name + ' [' + skill.source + ']\n    ' + String(skill.description || '').slice(0, 200)).join('\n') };
    }
    case 'config': {
      const configWords = String(argument || '').trim().split(/\s+/).filter(Boolean);
      if (configWords.length) {
        const pane = await import('./config-pane.mjs');
        const run = (command, value) => runBuiltinCommand(command, value, state);
        const [verb, key, ...rest] = configWords;
        try {
          if (verb === 'list' || verb === 'ls') return { output: await pane.describeConfig(state) };
          if (verb === 'get') {
            const item = pane.findConfigItem(key);
            if (!item) return { output: 'Unknown setting ' + key + '. Run /config list.' };
            const row = (await pane.configRows(state)).find((entry) => entry.item === item || entry.item.key === item.key);
            return { output: item.key + ' = ' + (row ? row.value : '') };
          }
          if (verb === 'set') return { output: await pane.setConfigValue(key, rest.join(' '), state, run) };
          if (pane.findConfigItem(verb) && key) return { output: await pane.setConfigValue(verb, [key, ...rest].join(' '), state, run) };
        } catch (error) { return { output: error.message }; }
        return { output: 'Usage: /config [list | get KEY | set KEY VALUE]' };
      }
      const settings = await loadSettings(root, { env });
      const lines = ['Settings files (later ones win):'];
      for (const source of settings.sources) lines.push('  ' + source.scope.padEnd(13) + ' ' + source.file);
      if (!settings.sources.length) lines.push('  (none yet)');
      if (settings.ignoredUntrusted.length) lines.push('  Ignored until you run oasis trust: ' + settings.ignoredUntrusted.join(', '));
      lines.push('Effective:');
      lines.push('  model          ' + (session ? session.config.model : settings.model || '(provider default)'));
      lines.push('  effort         ' + (sessionOptions.effort || 'auto'));
      lines.push('  permission     ' + (session ? session.permissions.mode : sessionOptions.permissionMode || settings.permissions.defaultMode) + ' (' + settings.permissions.allow.length + ' allow, ' + settings.permissions.ask.length + ' ask, ' + settings.permissions.deny.length + ' deny rules)');
      lines.push('  sandbox        ' + (settings.sandbox.enabled ? 'on' + (settings.sandbox.network ? ', network on' : ', network off') : 'off'));
      lines.push('  shell tool     ' + (settings.shell.enabled ? 'on' : 'off'));
      lines.push('  output style   ' + (sessionOptions.outputStyle || settings.outputStyle || 'default'));
      lines.push('  status line    ' + (settings.statusLine ? settings.statusLine.command : 'off'));
      lines.push('  hooks          ' + (Object.keys(settings.hooks).length ? Object.entries(settings.hooks).map(([event, groups]) => event + '×' + groups.length).join(', ') : 'none'));
      lines.push('  lsp servers    ' + (Object.keys(settings.lspServers || {}).length ? Object.keys(settings.lspServers).join(', ') : 'built-in only'));
      lines.push('  trusted        ' + (settings.trusted ? 'yes' : 'no'));
      lines.push('Edit .oasis/settings.json (project), .oasis/settings.local.json (personal), or your user settings; /permissions, /hooks, /mcp show details.');
      return { output: lines.join('\n') };
    }
    case 'doctor': {
      const { workspaceDoctor } = await import('./doctor.mjs');
      return { output: await workspaceDoctor(root, { env, session }) };
    }
    case 'release-notes': {
      const { runGitTool } = await import('./git-tools.mjs');
      const { fileURLToPath } = await import('node:url');
      const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const log = await runGitTool('git_log', appRoot, { limit: Number.parseInt(argument, 10) || 15 }, { env }).catch(() => null);
      if (!log || !log.ok || !log.commits.length) return { output: 'Release notes: https://github.com/FAHTHIZ/oasis/commits/main (this install has no Git history). Update with oasis update.' };
      return { output: ['Recent Oasis changes:', ...log.commits.map((c) => '  ' + c.date + '  ' + c.subject), 'Full history: https://github.com/FAHTHIZ/oasis/commits/main'].join('\n') };
    }
    case 'goal': {
      const stopWords = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'];
      if (!argument) {
        const goal = session && session.goal;
        if (!goal) return { output: 'No goal set. Usage: /goal CONDITION (for example: /goal all tests pass and the README documents the new flag)' };
        return { output: 'Goal' + (goal.achieved ? ' (achieved)' : goal.active ? ' (active)' : ' (cleared)') + ': ' + goal.condition + '\nTurns: ' + goal.turns + (goal.reason ? '\nLast check: ' + goal.reason : '') };
      }
      if (stopWords.includes(argument.toLowerCase())) {
        if (session && session.goal) session.goal.active = false;
        return { output: 'Goal cleared.' };
      }
      return { output: '[goal] Working until: ' + argument + '\nPress Ctrl+C to stop.', goal: { condition: argument, maxTurns: Number(env.OASIS_GOAL_MAX_TURNS) || 20 } };
    }
    case 'btw': {
      if (!argument) {
        const last = session && session.lastSideQuestion;
        return { output: last ? 'Last side question: ' + last.question + '\n\n' + last.answer : 'Usage: /btw QUESTION. The answer does not enter the conversation.' };
      }
      if (!session) return { output: 'Start a conversation first; /btw asks about the current session.' };
      const { askSideQuestion } = await import('./agent.mjs');
      const answer = await askSideQuestion(session, argument, { onUsage: (u) => usage && recordUsage(usage, { ...u, phase: 'side' }) });
      session.lastSideQuestion = { question: argument, answer };
      return { output: answer };
    }
    case 'color': {
      const { setPromptColor, getPromptColor, PROMPT_COLORS } = await import('./terminal-ui.mjs');
      if (!argument) return { output: 'Prompt color: ' + (getPromptColor() || 'default') + '. Choose ' + Object.keys(PROMPT_COLORS).join(', ') + ', random or default.' };
      try {
        const chosen = setPromptColor(argument);
        sessionOptions.promptColor = chosen === 'default' ? null : chosen;
        if (session) session.promptColor = sessionOptions.promptColor;
        return { output: 'Prompt color set to ' + chosen + '.' };
      } catch (error) { return { output: error.message }; }
    }
    case 'focus': {
      const { focusView } = await import('./terminal-ui.mjs');
      return { focus: focusView(session ? session.messages : [], { color: Boolean(state.color), width: state.width || 100 }) };
    }
    case 'background': {
      if (!session) return { output: 'Start a conversation first; /background hands the current session to a background agent. Use oasis --bg "task" to start a new one.' };
      return { background: { prompt: argument || 'Continue the task from where we left off. When you are done, summarize what you did.' } };
    }
    case 'debug': {
      const dbg = await import('./debug-log.mjs');
      if (String(argument).trim().toLowerCase() === 'off') { dbg.disableDebug(); return { output: 'Debug logging off.' }; }
      const file = dbg.debugEnabled() ? dbg.debugFile() : dbg.enableDebug({ categories: env.OASIS_DEBUG || 'all', file: env.OASIS_DEBUG_FILE || null, env, sessionId: session && session.sessionId });
      if (session) session.debugFile = file;
      if (!argument) return { output: 'Debug logging on: ' + file + '\nReproduce the problem, then run /debug DESCRIPTION to have Oasis read the log and troubleshoot it.' };
      return {
        output: 'Debug log: ' + file + '. Troubleshooting.',
        prompt: 'Troubleshoot this Oasis problem: ' + argument + '\n\nThe session debug log is at ' + file + ' (lines tagged [API], [TOOLS], [HOOKS], [MCP], [PERMISSIONS], [SESSION]). Read the end of it with run_command (for example `tail -n 200 ' + JSON.stringify(file) + '`), together with relevant settings files (.claude/settings.json, .oasis/settings.json, ~/.claude/settings.json), hook scripts and MCP configs. Identify the root cause, explain it in plain words, and propose or apply the fix. If the log does not show the problem yet, say what to reproduce.'
      };
    }
    case 'team-onboarding': {
      const days = Math.min(365, Math.max(1, parseInt(argument, 10) || 30));
      const { collectInsights, insightsSummaryText } = await import('./insights.mjs');
      const stats = await collectInsights({ env, days });
      const top = (map, n) => [...(map || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + ' (' + v + ')').join(', ') || 'none';
      const usage = [insightsSummaryText(stats), 'Slash commands used: ' + top(stats.commands, 12) + '.', 'Files touched most: ' + top(stats.files, 12) + '.', 'File types: ' + top(stats.extensions, 8) + '.'].join('\n');
      return {
        output: '[team-onboarding] Drafting an onboarding guide from ' + stats.sessions + ' sessions in the last ' + days + ' days.',
        prompt: 'Write a team onboarding guide for working on this project with Oasis (or Claude Code, which reads the same files). Base it on how the project is actually worked on. Usage over the last ' + days + ' days:\n' + usage + '\n\nAlso read, read-only: CLAUDE.md / AGENTS.md / OASIS.md and .claude/rules, .claude/settings.json and .oasis/settings.json (permissions, hooks, env; never copy secrets), .claude/commands, .claude/agents and .claude/skills, .mcp.json, the README, package scripts or Makefile targets, and the test setup. Then write ONBOARDING.md at the workspace root (ask before overwriting an existing file) with these sections: What this project is; Setup (install, provider/model config, MCP servers to connect); Everyday workflow (the commands, skills and agents people actually use, with when to use each); Project conventions the agent already follows (from the instruction files); Permissions and hooks in place, and why; Testing and verification; Common pitfalls (from the friction numbers above: tool errors, denials, corrections); and First tasks to try. Keep it concrete and short, and say where each fact came from.'
      };
    }
    case 'heapdump': {
      const v8 = await import('node:v8');
      const { mkdir } = await import('node:fs/promises');
      const { getConfigDirectory } = await import('./config.mjs');
      const dir = path.join(getConfigDirectory(env), 'debug');
      await mkdir(dir, { recursive: true });
      const file = v8.writeHeapSnapshot(path.join(dir, 'heap-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + process.pid + '.heapsnapshot'));
      const mem = process.memoryUsage();
      const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
      const heap = v8.getHeapSpaceStatistics().sort((a, b) => b.space_used_size - a.space_used_size).slice(0, 6).map((space) => '  ' + space.space_name.padEnd(26) + mb(space.space_used_size));
      const sessionInfo = session ? ['Session: ' + session.messages.length + ' messages, ~' + Math.round(JSON.stringify(session.messages).length / 1024) + ' KB of conversation' + (session.background ? ', ' + session.background.size + ' background commands' : '') + (session.mcpClients ? ', ' + session.mcpClients.size + ' MCP servers' : '')] : [];
      return { output: ['Heap snapshot: ' + file + ' (open it in Chrome DevTools > Memory).', 'RSS ' + mb(mem.rss) + ', heap ' + mb(mem.heapUsed) + ' of ' + mb(mem.heapTotal) + ', external ' + mb(mem.external) + ', array buffers ' + mb(mem.arrayBuffers) + '.', 'Largest heap spaces:', ...heap, ...sessionInfo].join('\n') };
    }
    case 'chrome': {
      if (!session) return { output: 'Start a conversation first, or launch with oasis --chrome.' };
      const { setChrome } = await import('./agent.mjs');
      const { findChrome } = await import('./cdp.mjs');
      const wanted = String(argument || '').trim().toLowerCase();
      const exe = env.OASIS_CHROME_PORT ? 'attached to port ' + env.OASIS_CHROME_PORT : findChrome(env);
      if (!wanted || wanted === 'status') return { output: 'Chrome tool: ' + (session.chromeEnabled ? 'on' : 'off') + (session.browserState ? ' (browser open)' : '') + '. Browser: ' + (exe || 'not found; set OASIS_CHROME_PATH') + '.' };
      if (wanted === 'off') { setChrome(session, false); return { output: 'Chrome tool off; the browser was closed.' }; }
      if (wanted !== 'on') return { output: 'Usage: /chrome [on|off|status]' };
      if (!exe) return { output: 'No Chrome, Chromium or Edge found. Install one or set OASIS_CHROME_PATH.' };
      setChrome(session, true);
      return { output: 'Chrome tool on (' + exe + '). The agent can now open pages, click, type, take screenshots and read the console.' };
    }
    case 'bug': {
      const { readFile } = await import('node:fs/promises');
      const os = await import('node:os');
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      const repo = String(pkg.repository && pkg.repository.url || pkg.repository || 'https://github.com/FAHTHIZ/oasis').replace(/^git\+/, '').replace(/\.git$/, '');
      const withTranscript = /(^|\s)--with-transcript\b/.test(argument);
      const report = argument.replace(/(^|\s)--with-transcript\b/, '').trim();
      const config = session && session.config || {};
      const lines = ['## What happened', report || '(describe the bug)', '', '## Environment', '- OASIS ' + pkg.version, '- Node ' + process.version + ' on ' + process.platform + ' ' + os.release(), '- Provider protocol: ' + (config.protocol || 'unknown') + ', model: ' + (config.model || 'unknown')];
      if (withTranscript && session) {
        const tail = session.messages.filter((m) => m.role !== 'system' && typeof m.content === 'string').slice(-6).map((m) => '**' + m.role + ':** ' + m.content.slice(0, 600).replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')).join('\n\n');
        if (tail) lines.push('', '## Recent conversation (last 6 messages, trimmed)', tail);
      }
      const body = lines.join('\n').slice(0, 6000);
      const url = repo + '/issues/new?title=' + encodeURIComponent('Bug: ' + (report.split('\n')[0] || 'describe the problem').slice(0, 80)) + '&body=' + encodeURIComponent(body);
      return { output: 'Nothing has been sent. Review and submit the issue here:\n' + url + (withTranscript ? '' : '\nAdd --with-transcript to include the last few messages (secrets that look like API keys are redacted; check before submitting).') };
    }
    case 'setup-bedrock':
    case 'setup-vertex': {
      const setup = await import('./cloud-setup.mjs');
      const provider = name === 'setup-bedrock' ? 'bedrock' : 'vertex';
      const { save, values } = setup.parseSetupArgs(argument);
      const plan = await setup.cloudSetupPlan(provider, values, env);
      const text = setup.describePlan(plan, env);
      let confirmed = save;
      if (!confirmed && typeof state.confirm === 'function') confirmed = await state.confirm(text + '\nSave these settings?');
      if (!confirmed) return { output: text + '\nNothing saved. Run /' + name + ' ' + (argument ? argument + ' ' : '') + 'save to write them.' };
      const file = await setup.saveCloudSetup(plan, env);
      return { output: text + '\nSaved to ' + file + '. Restart OASIS to use ' + (provider === 'bedrock' ? 'Amazon Bedrock' : 'Vertex AI') + (plan.problems.length ? ' after fixing the problems above' : '') + '.' };
    }
    case 'auto-mode-setup': {
      const { draftAutoModeEnvironment } = await import('./auto-mode.mjs');
      const { updateUserSettings, userSettingsPath } = await import('./settings.mjs');
      const drafted = await draftAutoModeEnvironment(root);
      if (!drafted.length) return { output: 'Found nothing project-specific to add (no remotes, registries, CI or infrastructure config). The default environment stays in place; edit autoMode.environment in ' + userSettingsPath(env) + ' to add trusted hosts by hand.' };
      const text = 'Drafted autoMode.environment entries (added after "$defaults"):\n' + drafted.map((line) => '  - ' + line).join('\n');
      const save = /(^|\s)(save|--yes|-y)(\s|$)/.test(argument);
      const confirmed = save || (typeof state.confirm === 'function' && await state.confirm(text + '\nSave to your user settings?'));
      if (!confirmed) return { output: text + '\nNothing saved. Run /auto-mode-setup save to write them, or copy the lines you want.' };
      await updateUserSettings((settings) => {
        const autoMode = settings.autoMode && typeof settings.autoMode === 'object' ? settings.autoMode : {};
        const current = Array.isArray(autoMode.environment) ? autoMode.environment : ['$defaults'];
        const merged = [...(current.includes('$defaults') ? [] : ['$defaults']), ...current];
        for (const line of drafted) if (!merged.includes(line)) merged.push(line);
        settings.autoMode = { ...autoMode, environment: merged };
        return settings;
      }, env);
      return { output: text + '\nSaved to ' + userSettingsPath(env) + '. Check the result with oasis auto-mode config.' };
    }
    case 'autofix-pr': {
      const extra = argument ? '\nExtra instructions from the user: ' + argument : '';
      return { output: 'Watching the pull request for this branch and fixing CI failures and review comments.', prompt: [
        'Autofix the pull request for the current branch until it is green.' + extra,
        '1. Find the PR: `gh pr view --json number,url,headRefName,statusCheckRollup,reviewDecision`. If there is none, stop and say so.',
        '2. Collect what needs fixing: failing checks (`gh pr checks`, then `gh run view RUN_ID --log-failed` for each failed run) and unresolved review comments (`gh api repos/{owner}/{repo}/pulls/NUMBER/comments` and `gh pr view NUMBER --comments`).',
        '3. Fix each real problem with the smallest correct change. Reproduce failing tests locally first and rerun them after the fix. Skip comments that are questions or that you disagree with; reply to those instead of changing code.',
        '4. Commit with a message naming what was fixed and push to the PR branch (never force-push, never push to the default branch).',
        '5. Wait for the new checks: use the Monitor tool or `gh pr checks --watch` with a timeout, then repeat from step 2. Stop after 5 rounds, when everything passes, or when the remaining failures are unrelated to this PR (flaky or infrastructure); explain which.',
        '6. Report the PR URL, what you fixed in each round, and anything left for the user.'
      ].join('\n') };
    }
    case 'logout': {
      const { authLogout } = await import('./auth-cli.mjs');
      const out = await authLogout(env);
      return { output: (out.removed ? 'Removed the stored API key from ' + out.file + '. The current session keeps working until you exit.' : 'No stored API key in ' + out.file + '.') + (out.envKeys.length ? ' Still set in your environment: ' + out.envKeys.join(', ') + '.' : '') };
    }
    case 'login': {
      const { authStatus, describeAuthStatus } = await import('./auth-cli.mjs');
      return { output: describeAuthStatus(await authStatus(env)) + '\nTo connect or switch providers, exit and run oasis auth login (or oasis auth login --api-key-stdin < keyfile). Use /model to switch models.' };
    }
    case 'skill-doctor': {
      const { skillDoctor, skillDoctorText } = await import('./skill-doctor.mjs');
      const settings = (session && session.settings) || state.settings || null;
      const report = await skillDoctor((session && session.root) || state.root || process.cwd(), { env, settings, days: Math.min(365, Math.max(1, parseInt(argument, 10) || 30)) });
      return { output: skillDoctorText(report) };
    }
    case 'insights': {
      const days = Math.min(365, Math.max(1, parseInt(argument, 10) || 30));
      const { writeInsightsReport, insightsSummaryText } = await import('./insights.mjs');
      const narrate = session && session.config ? async (summary) => {
        const { completeText } = await import('./agent.mjs');
        return completeText(session, 'You write a short, friendly usage summary for a developer about how they use their AI coding agent. Two short paragraphs: what they mostly work on and how, then the one or two changes that would help most. Plain text, no lists, no headings.', summary);
      } : null;
      const { file, stats } = await writeInsightsReport({ env, days, narrate });
      if (typeof state.openFile === 'function') state.openFile(file);
      return { output: insightsSummaryText(stats) + '\nReport: ' + file };
    }
    case 'import': {
      const { planImport, describePlan, applyImport, parseImportArgs } = await import('./importers.mjs');
      let parsed;
      try { parsed = parseImportArgs(argument); } catch (error) { return { output: error.message }; }
      const plan = await planImport(root, { sources: parsed.sources, env });
      const description = describePlan(plan);
      const pending = plan.items.filter((item) => item.action !== 'skip');
      if (!pending.length || parsed.dryRun) return { output: description + (parsed.dryRun && pending.length ? '\nDry run: nothing was written.' : '') };
      if (!parsed.yes) {
        if (typeof state.confirm !== 'function') return { output: description + '\nRun /import ' + [...parsed.sources, '--yes'].join(' ') + ' to write these.' };
        if (!(await state.confirm(description + '\nImport these ' + pending.length + ' items?'))) return { output: 'Import cancelled.' };
      }
      const done = await applyImport(plan);
      return { output: description + '\nImported ' + done.length + ' item' + (done.length === 1 ? '' : 's') + '. Run /reload-plugins or start a new session to use new MCP servers; commands and rules apply on the next turn or session.' };
    }
    case 'advisor': {
      if (!session) return { output: 'Start a conversation first, or set "advisorModel" in settings or pass --advisor MODEL.' };
      const { setAdvisor } = await import('./agent.mjs');
      if (!argument) {
        const u = session.advisorUsage;
        return { output: session.advisorModel ? 'Advisor: ' + session.advisorModel + (u ? ' (' + u.calls + ' consultation' + (u.calls === 1 ? '' : 's') + ', ' + u.input + ' in / ' + u.output + ' out tokens)' : ' (not consulted yet)') + '. /advisor off turns it off.' : 'No advisor. /advisor MODEL (for example /advisor opus) lets the agent consult that model mid-task.' };
      }
      let chosen;
      try { chosen = setAdvisor(session, argument); } catch (error) { return { output: error.message }; }
      return { output: chosen ? 'Advisor set to ' + chosen + '. The agent can now consult it with the advisor tool.' : 'Advisor turned off.' };
    }
    case 'subtask': {
      if (!argument) return { output: 'Usage: /subtask TASK. A background copy of this conversation works on TASK and reports back here.' };
      if (!session) return { output: 'Start a conversation first; /subtask forks the current session.' };
      const { startSubtask } = await import('./agent.mjs');
      try {
        const started = await startSubtask(session, argument, { env, autoApprove: Boolean(state.autoApprove) });
        return { output: '[subtask] Started ' + started.id + ' with a copy of this conversation. Its report comes back here when it finishes (/tasks to check on it).' };
      } catch (error) { return { output: 'Could not start the subtask: ' + error.message }; }
    }
    case 'recap': {
      if (!session || session.messages.length < 2) return { output: 'Nothing to recap yet.' };
      const { askSideQuestion } = await import('./agent.mjs');
      return { output: await askSideQuestion(session, 'Give a one-line recap of this session: what was asked, what is done, and what is next. One line only.') };
    }
    case 'rename': {
      if (!session) return { output: 'Start a conversation first; /rename names the current session.' };
      let name = argument.replace(/[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!name) {
        const first = session.messages.find((m) => m.role === 'user' && typeof m.content === 'string');
        name = first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
        if (!name) return { output: 'Usage: /rename NAME' };
      }
      session.sessionName = name;
      return { output: 'Session renamed to "' + name + '". It is saved with the session and shown in /resume.' };
    }
    case 'simplify':
      return { output: '[simplify] Reviewing changed code.', prompt: 'Review the code changed in this workspace' + (argument ? ' (focus: ' + argument + ')' : ' (use git diff against HEAD; include untracked files)') + ' and simplify it. Run four read-only review subagents in parallel with the task tool, one each for: (1) reuse: code that duplicates existing helpers or libraries in this repo; (2) simplification: needless branches, indirection, dead code, over-long functions; (3) efficiency: wasted work, repeated I/O, quadratic loops; (4) abstraction: whether the change sits at the right layer and matches local patterns. Then apply the fixes that keep behavior identical, run the relevant tests, and summarize what changed. Do not change behavior or public interfaces, and do not look for bugs; that is /review.' };
    case 'verify':
      return { output: '[verify] Verifying the change by running it.', prompt: 'Verify that the recent change actually works by running it, not just by reading code or relying on type checks. ' + (argument ? 'Check specifically: ' + argument + '. ' : '') + 'Find how this project builds and runs (package scripts, Makefile, README). Build it, start the app or CLI (use run_command with background=true and monitor_command for servers), exercise the changed behavior with real inputs or requests, and observe the output. Run the relevant tests too. Report exactly what you ran, what you observed, and whether it works. If you cannot run it, say why instead of guessing.' };
    case 'batch': {
      if (!argument) return { output: 'Usage: /batch INSTRUCTION (for example: /batch migrate every route in src/api to the new error helper)' };
      return { output: '[batch] Planning parallel work.', prompt: 'Carry out this large change in parallel: ' + argument + '\n\nSteps: (1) Call enter_plan_mode, then research the codebase read-only and split the work into 5 to 30 independent units that touch disjoint files. (2) Call exit_plan_mode with the list of units and how each will be verified, and wait for approval. (3) After approval, run one task subagent per unit with isolation "worktree" so each works on its own branch; run up to six at a time in parallel. Each unit must make its change, run the relevant tests, and commit. (4) When all finish, list each unit with its branch, result and test outcome, and tell the user to review them with /worktrees.' };
    }
    case 'schedule': {
      if (!session) return { output: 'Start a conversation first; scheduled prompts run inside this session.' };
      const tools = await import('./session-tools.mjs');
      const [sub, ...rest] = argument.split(/\s+/);
      if (!argument || sub === 'list') {
        const jobs = tools.listCronJobs(session).jobs;
        return { output: jobs.length ? jobs.map((job) => job.id + '  ' + job.cron + '  ' + (job.recurring ? 'every match' : 'once') + '  next ' + (job.next_run || '-') + '\n    ' + job.prompt).join('\n') : 'No scheduled prompts. Usage: /schedule "*/30 * * * *" check CI and fix failures' };
      }
      if (sub === 'delete' || sub === 'cancel') return { output: tools.deleteCronJob(session, rest[0]).deleted ? 'Deleted ' + rest[0] + '.' : 'No job ' + rest[0] + '.' };
      const quoted = argument.match(/^["']([^"']+)["']\s+([\s\S]+)$/);
      const parts = argument.split(/\s+/);
      const cron = quoted ? quoted[1] : parts.slice(0, 5).join(' ');
      const prompt = quoted ? quoted[2] : parts.slice(5).join(' ');
      try {
        const job = tools.createCronJob(session, { cron, prompt });
        return { output: 'Scheduled ' + job.id + ' (' + job.cron + '), next run ' + job.next_run + '. It runs while this session stays open.' };
      } catch (error) { return { output: error.message + '\nUsage: /schedule CRON PROMPT, for example /schedule "0 9 * * 1-5" summarize open PRs' }; }
    }
    case 'fewer-permission-prompts':
      return { output: '[permissions] Looking for safe commands to allowlist.', prompt: 'Help me get fewer permission prompts. Read this project\'s saved Oasis sessions and settings (.oasis/settings.json, .oasis/settings.local.json; sessions are listed by /resume) and find commands and MCP tools I approved repeatedly. Keep only clearly read-only ones (for example git status, git diff, git log, ls, test runners, linters, read-only MCP getters). Never include anything that writes, deletes, installs, pushes, or runs arbitrary code (no rm, curl | sh, npm install, git push, bash -c). Show the prioritized list with a one-line reason each, then add them to permissions.allow in .oasis/settings.json using rules like "run_command(git status)" or "run_command(npm test:*)" after I approve.' };
    case 'diff': {
      const { spawnSync } = await import('node:child_process');
      const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env });
      const inside = git(['rev-parse', '--is-inside-work-tree']);
      if (inside.status !== 0) return { output: 'Not a Git repository; /diff needs Git.' };
      const words = argument ? argument.split(/\s+/).filter(Boolean) : [];
      const stat = words.includes('--stat');
      const paths = words.filter((word) => !word.startsWith('-'));
      const hasHead = git(['rev-parse', '--verify', '-q', 'HEAD']).status === 0;
      const color = env.NO_COLOR ? 'never' : 'always';
      const diff = git(['diff', '--color=' + color, ...(stat ? ['--stat'] : []), ...(hasHead ? ['HEAD'] : ['--cached']), '--', ...paths]);
      const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...paths]).stdout.split('\n').filter(Boolean);
      let text = String(diff.stdout || '').trimEnd();
      const limit = 200_000;
      if (text.length > limit) text = text.slice(0, limit) + '\n… diff truncated (' + Math.round(diff.stdout.length / 1024) + ' KB); try /diff --stat or /diff PATH';
      const lines = [];
      if (text) lines.push(text);
      if (untracked.length) lines.push('Untracked files:\n' + untracked.slice(0, 50).map((file) => '  ' + file).join('\n') + (untracked.length > 50 ? '\n  … ' + (untracked.length - 50) + ' more' : ''));
      return { output: lines.length ? lines.join('\n\n') : 'No uncommitted changes' + (paths.length ? ' in ' + paths.join(' ') : '') + '.' };
    }
    case 'autocompact': {
      if (!session) return { output: 'Start a conversation first; /autocompact applies to the current session (set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE for every session).' };
      const config = session.config || (session.config = {});
      const { compactionThresholdChars } = await import('./context.mjs');
      const word = argument.toLowerCase().replace(/%$/, '');
      if (!word) {
        const chars = compactionThresholdChars(config || {}, env);
        const window = contextWindowSize(config || {}, env);
        return { output: 'Auto-compaction triggers at about ' + Math.round(chars / 4).toLocaleString() + ' tokens (' + Math.round(chars / 4 / window * 100) + '% of a ' + window.toLocaleString() + '-token window)' + (config && config.autoCompactPercent === 0 ? ' — off' : '') + '.\nUsage: /autocompact PERCENT | off | reset' };
      }
      if (word === 'reset') { if (config) delete config.autoCompactPercent; return { output: 'Auto-compaction threshold reset to the default.' }; }
      const pct = word === 'off' ? 0 : Number(word);
      if (!(pct === 0 || (Number.isInteger(pct) && pct >= 1 && pct <= 100))) return { output: 'Usage: /autocompact PERCENT (1-100) | off | reset' };
      if (config) config.autoCompactPercent = pct;
      return { output: pct === 0 ? 'Auto-compaction off for this session (/compact still works).' : 'Auto-compaction will trigger at ' + pct + '% of the context window for this session.' };
    }
    case 'reload-plugins':
    case 'reload-skills': {
      if (!session) return { output: 'Nothing to reload yet; plugins and skills load fresh when the next session starts.' };
      return { output: '', reload: name === 'reload-plugins' ? 'plugins' : 'skills' };
    }
    case 'list-agents': {
      const { listAgents } = await import('./agent-tasks.mjs');
      const agents = session ? listAgents(session) : [];
      const teams = session ? listAgentTeams(session) : [];
      const procs = session && session.background ? [...session.background.values()] : [];
      const lines = [];
      if (agents.length) { lines.push('Subagents:'); for (const agent of agents) lines.push('  ' + agent.id.padEnd(9) + ' ' + agent.status.padEnd(10) + ' ' + agent.agent + ': ' + agent.description); }
      if (teams.length) { lines.push('Agent teams:'); for (const team of teams) lines.push('  ' + team.id + '  ' + team.name + '  ' + team.status + '  ' + team.running + '/' + team.member_count + ' running'); }
      if (procs.length) { lines.push('Background processes:'); for (const entry of procs) lines.push('  ' + entry.id + '  ' + entry.status + '  ' + entry.command); }
      if (!lines.length) return { output: 'No subagents, teammates or background processes in this session. Message a running agent with send_message, or start one with the task tool.' };
      lines.push('Message one with send_message (agents) or team_send_message (teammates); stop with /tasks stop ID.');
      return { output: lines.join('\n') };
    }
    case 'statusline':
      return { output: '[statusline] Setting up a status line.', prompt: 'Set up an Oasis status line for me' + (argument ? ': ' + argument : ' that shows the model, the current directory and the Git branch') + '. Oasis runs the "statusLine" command from settings ({ "statusLine": { "type": "command", "command": "...", "padding": 0 } }) and pipes JSON session data on stdin (model.display_name, workspace.current_dir, cost, session_id and so on); the first line of stdout is shown under the prompt, ANSI colors allowed. If ~/.claude/settings.json already has a statusLine, reuse it. Write a small script under ~/.config/oasis/ (or the OASIS config directory), make it executable, test it by piping sample JSON into it, then add statusLine to my user settings file. Show me the result.' };
    case 'update-config':
      if (!argument) return { output: 'Usage: /update-config DESCRIPTION (for example: /update-config always allow npm test, or /update-config use the light theme)' };
      return { output: '[config] Updating settings.', prompt: 'Change my Oasis settings: ' + argument + '\n\nPick the right file: project .oasis/settings.json (shared with the team), .oasis/settings.local.json (personal, this project) or the user settings file in the OASIS config directory (all projects). Claude Code settings keys work (permissions.allow/deny/ask, hooks, env, model, statusLine, theme, outputStyle, sandbox, enabledPlugins, and so on). Read the file first, make the smallest edit that keeps it valid JSON, then tell me what changed and where.' };
    case 'theme': {
      // Claude Code-compatible themes; the choice is saved as "theme" in user settings.
      const themes = await import('./themes.mjs');
      const { userSettingsPath } = await import('./settings.mjs');
      const { readFile, writeFile, mkdir } = await import('node:fs/promises');
      const settings = (session && session.settings) || state.settings || null;
      const plugins = (settings && settings.pluginThemeSources) || [];
      const wanted = String(argument || '').trim();
      const list = themes.listThemes({ env, plugins });
      const current = themes.currentTheme();
      if (!wanted || wanted === 'list') {
        const preference = themes.themePreference({ env, settings });
        const lines = list.map((theme) => (theme.id === preference ? '● ' : '  ') + theme.id.padEnd(28) + (theme.name !== theme.id ? ' ' + theme.name : ''));
        return { output: 'Themes (current: ' + current.name + '):\n' + lines.join('\n') + '\n\n' + themes.themePreview(current) + '\n\nUse /theme NAME to switch. Custom themes are JSON files in ~/.claude/themes/ ({ "name", "base", "overrides" }).' };
      }
      if (!list.some((theme) => theme.id === wanted)) return { output: 'Unknown theme "' + wanted + '". Run /theme to list the available themes.' };
      const theme = themes.applyTheme(themes.resolveTheme(wanted, { env, plugins }));
      if (settings) settings.theme = wanted;
      const file = userSettingsPath(env);
      let saved = {};
      try { saved = JSON.parse(await readFile(file, 'utf8')) || {}; } catch {}
      saved.theme = wanted;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(saved, null, 2) + '\n', 'utf8');
      return { output: 'Theme set to ' + theme.name + (env.OASIS_THEME ? ' (OASIS_THEME is set and wins at the next start)' : '') + '.\n' + themes.themePreview(theme) };
    }
    case 'vim': {
      // Toggle vim editing for the prompt; saved as "editorMode" in user settings.
      const { userSettingsPath } = await import('./settings.mjs');
      const { readFile, writeFile, mkdir } = await import('node:fs/promises');
      const current = sessionOptions.editorMode || (session && session.settings && session.settings.editorMode) || 'normal';
      const wanted = /^(on|vim)$/i.test(argument) ? 'vim' : /^(off|normal|emacs)$/i.test(argument) ? 'normal' : current === 'vim' ? 'normal' : 'vim';
      sessionOptions.editorMode = wanted;
      if (session && session.settings) session.settings.editorMode = wanted;
      const file = userSettingsPath(env);
      let saved = {};
      try { saved = JSON.parse(await readFile(file, 'utf8')) || {}; } catch {}
      saved.editorMode = wanted;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(saved, null, 2) + '\n', 'utf8');
      return { output: wanted === 'vim' ? 'Vim mode on. Esc enters NORMAL mode; i, a, o, A, I return to INSERT. /vim again to turn it off.' : 'Vim mode off (standard editing).' };
    }
    case 'tips': {
      const { startupTip } = await import('./terminal-ui.mjs');
      const tip = startupTip(env);
      return { output: [
        'OASIS tip:',
        tip || 'Startup tips are disabled. Set OASIS_TIP=on or remove OASIS_NO_TIPS to show them again.',
        '',
        'Useful starting points: /plan for risky work, /context for token estimates, /cost for usage, /undo to roll back, and /keys for shortcuts.'
      ].join('\n') };
    }
    case 'keys':
    case 'keybindings': {
      const { SHORTCUTS_HELP } = await import('./line-editor.mjs');
      const kb = await import('./keybindings.mjs');
      const env = state.env || process.env;
      const sub = String(argument || '').trim().toLowerCase();
      if (sub === 'init' || sub === 'edit' || sub === 'open') {
        const { file, created } = await kb.ensureKeybindingsFile(env);
        return { output: (created ? 'Created ' : 'Keybindings file: ') + file + '\nEdit it to rebind keys; changes apply at the next prompt. Contexts: ' + kb.CONTEXTS.join(', ') + '.' };
      }
      const info = kb.describeKeybindings(env);
      const lines = ['Keyboard shortcuts:', ...SHORTCUTS_HELP, '  While a turn runs: Esc interrupts it, and anything you type is queued as the next message.'];
      lines.push('', info.lines.length ? 'Custom keybindings:' : 'No custom keybindings. Run /keybindings init to create ' + kb.keybindingFiles(env)[1] + '.');
      lines.push(...info.lines);
      if (info.warnings.length) lines.push('', 'Warnings:', ...info.warnings.map((w) => '  ' + w));
      if (info.files.length) lines.push('', 'Loaded from: ' + info.files.join(', '));
      return { output: lines.join('\n') };
    }
    case 'terminal-setup':
      return { output: [
        'Newlines in the prompt work everywhere with \\ then Enter, or Ctrl+J.',
        'Shift+Enter works out of the box in terminals that report modified keys (kitty, WezTerm, foot, Ghostty, iTerm2 with CSI u).',
        'VS Code / Cursor: add to keybindings.json:',
        '  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b\\r" }, "when": "terminalFocus" }',
        'Alacritty: [[keyboard.bindings]] key = "Return", mods = "Shift", chars = "\\u001b\\r"',
        'Apple Terminal: Settings > Profiles > Keyboard > "Use Option as Meta key", then Option+Enter inserts a newline.',
        'tmux: set -g extended-keys on'
      ].join('\n') };
    case 'privacy-settings':
      return { output: [
        'Oasis has no telemetry. Nothing is sent anywhere except:',
        '  - your configured model provider (' + ((session && session.config && session.config.protocol) || 'see /status') + '): prompts, file contents you share, tool results',
        '  - web_search / fetch_url when the model uses them (turn off with "permissions": {"deny": ["web_search", "fetch_url"]})',
        '  - MCP servers you configured (see /mcp)',
        'Local data: saved sessions (oasis --no-session-persistence to skip saving), prompt history in ~/.oasis/history.jsonl (OASIS_NO_HISTORY=1), auto memory (/memory).',
        'For fully local use, point Oasis at Ollama or LM Studio with /setup.'
      ].join('\n') };
    case 'stop': {
      if (!session) return { output: 'Nothing is running.' };
      const { stopAllAgents } = await import('./agent-tasks.mjs').catch(() => ({}));
      let agents = 0;
      if (session.agentTasks && stopAllAgents) { agents = [...session.agentTasks.agents.values()].filter((t) => t.status === 'running').length; stopAllAgents(session); }
      let processes = 0;
      if (session.background) for (const entry of session.background.values()) if (entry.status === 'running' && entry.child) { try { entry.child.kill('SIGTERM'); entry.status = 'killed'; processes += 1; } catch {} }
      return { output: 'Stopped ' + agents + ' background agent(s) and ' + processes + ' process(es).' };
    }
    case 'loop': {
      const parsed = parseLoopArgs(argument);
      if (parsed.error) return { output: parsed.error };
      return { output: '[loop] ' + (parsed.selfPaced ? 'Self-paced: the model picks each next run (1m-1h) or stops when done' : 'Running every ' + formatInterval(parsed.intervalMs)) + (parsed.times ? ', ' + parsed.times + ' times' : '') + '. Press Ctrl+C to stop.', loop: parsed };
    }
    case 'cd': {
      if (!argument) return { output: 'Workspace: ' + root + '\nUsage: /cd PATH' };
      const { stat } = await import('node:fs/promises');
      const os = await import('node:os');
      const target = path.resolve(root, argument.replace(/^~(?=$|[\\/])/, os.homedir()));
      const info = await stat(target).catch(() => null);
      if (!info || !info.isDirectory()) return { output: 'Not a directory: ' + target };
      if (target === path.resolve(root)) return { output: 'Already in ' + target + '.' };
      return { output: 'Switched workspace to ' + target + '. The next message starts a fresh conversation there.', cd: target };
    }
    case 'sandbox': {
      const { resolveSandbox, detectSandbox } = await import('./sandbox.mjs');
      const current = session && session.sandbox || null;
      const describe = (box) => box && box.enabled ? (box.available ? 'on (' + box.kind + (box.network ? ', network on' : ', network off') + ')' : 'on but unavailable - ' + box.reason) : 'off';
      if (!argument) {
        const probe = detectSandbox();
        return { output: 'Sandbox: ' + describe(current) + '. This machine: ' + (probe.available ? probe.kind + ' available' : 'no sandbox - ' + probe.reason) + '.\nUsage: /sandbox on | off | network on | network off. Make it permanent with "sandbox": {"enabled": true} in settings.' };
      }
      if (!session) return { output: 'Start a task first; /sandbox changes the running session.' };
      const words = argument.toLowerCase().split(/\s+/);
      let enabled = Boolean(current && current.enabled);
      let network = Boolean(current && current.network);
      if (words[0] === 'on') enabled = true;
      else if (words[0] === 'off') enabled = false;
      else if (words[0] === 'network' && ['on', 'off'].includes(words[1])) { enabled = true; network = words[1] === 'on'; }
      else return { output: 'Usage: /sandbox on | off | network on | network off' };
      const writable = current && current.writable || [root];
      session.sandbox = resolveSandbox({ sandbox: { enabled, network, autoAllowCommands: current ? current.autoAllowCommands !== false : true } }, root);
      if (session.sandbox.enabled) session.sandbox.writable = writable;
      return { output: 'Sandbox for this session: ' + describe(session.sandbox) + '.' };
    }
    case 'workflows': {
      const wf = await import('./workflows.mjs');
      const runs = session && session.workflowRuns ? session.workflowRuns : new Map();
      const words = argument ? argument.split(/\s+/) : [];
      if (words[0] === 'stop' && words[1]) {
        const run = runs.get(words[1]);
        if (!run) return { output: 'No workflow run ' + words[1] + '.' };
        run.controller.abort();
        return { output: 'Stopping workflow ' + run.id + '. Ask to resume it later with resume_run_id ' + run.id + '.' };
      }
      if (words[0] === 'save' && words[1]) {
        const run = runs.get(words[1]);
        if (!run) return { output: 'No workflow run ' + words[1] + '.' };
        const { readFile } = await import('node:fs/promises');
        const target = await wf.saveWorkflow(await readFile(run.scriptPath, 'utf8'), { root, env, scope: words.includes('--user') ? 'user' : 'project', name: words.find((word, index) => index > 1 && !word.startsWith('--')) || null });
        return { output: 'Saved workflow to ' + (target.file || target) + '. Run it with /' + String(target).split(/[\\/]/).pop().replace(/\.js$/, '') + '.' };
      }
      if (words[0] && runs.has(words[0])) return { output: wf.describeRun(runs.get(words[0]), { detail: true }) };
      const lines = [];
      if (runs.size) { lines.push('Workflow runs:'); for (const run of runs.values()) lines.push('  ' + wf.describeRun(run)); }
      const saved = await wf.loadWorkflows(root, { env }).catch(() => new Map());
      if (saved.size) { lines.push('Saved workflows (run as /name):'); for (const item of saved.values()) lines.push('  /' + item.name.padEnd(18) + ' ' + item.scope.padEnd(8) + ' ' + item.description); }
      return { output: lines.length ? lines.join('\n') : 'No workflows yet. Ask for a workflow (or say ultracode) to start one.' };
    }
    case 'tasks': {
      const { listAgents, getAgent, stopAgent, summarizeAgent } = await import('./agent-tasks.mjs');
      const words = argument ? argument.split(/\s+/) : [];
      if (session && words[0] === 'stop' && words[1]) {
        if (session.agentTasks && session.agentTasks.agents.has(words[1])) return { output: stopAgent(session, { id: words[1] }).message };
        const proc = session.background && session.background.get(words[1]);
        if (proc) {
          const { killAllBackground } = await import('./power-tools.mjs');
          killAllBackground(new Map([[words[1], proc]]));
          return { output: 'Stopped background process ' + words[1] + '.' };
        }
        return { output: 'No agent or process with id ' + words[1] + '.' };
      }
      if (session && words[0] && session.agentTasks && session.agentTasks.agents.has(words[0])) {
        const info = summarizeAgent(getAgent(session, words[0]), { full: true });
        return { output: [info.id + '  ' + info.status + '  ' + info.agent + '  ' + info.description + '  (' + info.elapsed + ', ' + info.toolCalls + ' tool calls)', info.error ? 'Error: ' + info.error : '', info.report || (info.recentTools ? 'Recent tools: ' + info.recentTools.join(', ') : '')].filter(Boolean).join('\n') };
      }
      const agents = session ? listAgents(session) : [];
      const procs = session && session.background ? [...session.background.values()] : [];
      if (!agents.length && !procs.length) return { output: 'No subagents or background processes in this session.' };
      const lines = [];
      if (agents.length) {
        lines.push('Agents:');
        for (const agent of agents) lines.push('  ' + agent.id.padEnd(9) + ' ' + agent.status.padEnd(10) + ' ' + (agent.background ? 'bg ' : 'fg ') + agent.agent + ': ' + agent.description + '  (' + agent.elapsed + ', ' + agent.toolCalls + ' tool calls' + (agent.recentTools ? ', now: ' + agent.recentTools[agent.recentTools.length - 1] : '') + ')');
      }
      if (procs.length) {
        lines.push('Processes:');
        for (const entry of procs) lines.push('  ' + entry.id + '  ' + entry.status + (entry.exitCode !== null ? ' (exit ' + entry.exitCode + ')' : '') + '  ' + entry.command);
      }
      lines.push('Details: /tasks ID   Stop: /tasks stop ID');
      return { output: lines.join('\n') };
    }
    case 'bashes': {
      const list = session && session.background ? [...session.background.values()] : [];
      if (!list.length) return { output: 'No background processes.' };
      return { output: list.map((entry) => entry.id + '  ' + entry.status + (entry.exitCode !== null ? ' (exit ' + entry.exitCode + ')' : '') + '  ' + entry.command).join('\n') };
    }
    case 'todos': {
      const todos = session && session.todos || [];
      if (!todos.length) return { output: 'No todos yet.' };
      const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
      return { output: todos.map((todo) => (mark[todo.status] || '[ ]') + ' ' + (todo.content || todo.text || todo.title || '')).join('\n') };
    }
    case 'memory': {
      const memory = await import('./auto-memory.mjs');
      const [sub, ...restWords] = argument.split(/\s+/).filter(Boolean);
      const rest = restWords.join(' ');
      if (sub === 'search') {
        if (!rest) return { output: 'Usage: /memory search WORDS' };
        const ranked = memory.rankMemories(await memory.listMemories(root, { env }), rest, { limit: 10 });
        return { output: ranked.length ? ranked.map(({ memory: item, score }) => item.id + '  (' + score.toFixed(2) + ')\n    ' + item.description).join('\n') : 'No memories match.' };
      }
      if (sub === 'show') {
        const item = await memory.findMemory(root, rest, { env });
        return { output: item ? item.id + '\n' + item.file + '\nupdated ' + item.updated + ', recalled ' + item.recalls + ' times\n\n' + item.content : 'No memory matches ' + rest + '.' };
      }
      if (sub === 'forget' || sub === 'delete') {
        try { const removed = await memory.deleteMemory(root, rest, { env }); return { output: 'Deleted ' + removed.deleted + '.' }; } catch (error) { return { output: error.message }; }
      }
      if (sub === 'path') {
        const roots = memory.memoryRoots(root, env);
        return { output: 'Project memory: ' + roots.project + '\nUser memory:    ' + roots.user };
      }
      if (sub === 'add' || sub === 'save') {
        if (!rest) return { output: 'Usage: /memory add NOTE  (add "user:" in front to save it for every project)' };
        const userScope = /^user:\s*/i.test(rest);
        const text = rest.replace(/^(user|project):\s*/i, '');
        const saved = await memory.saveMemory(root, { name: text.split(/[.:\n]/)[0].slice(0, 60), content: text, scope: userScope ? 'user' : 'project', category: userScope ? 'preferences' : 'project' }, { env });
        return { output: 'Memory ' + saved.action + ': ' + saved.id + (saved.redacted ? ' (secrets were redacted)' : '') };
      }
      const files = await memoryFiles(root, { env });
      const lines = ['Instruction files:'];
      lines.push(...files.map((file) => '  ' + (file.exists ? '[loaded] ' : '[none]   ') + file.label + ': ' + file.path));
      const items = await memory.listMemories(root, { env });
      const enabled = memory.autoMemoryEnabled(session && session.settings || {}, env);
      lines.push('Auto memory (' + (enabled ? 'on' : 'off') + '): ' + items.length + ' saved');
      for (const item of items.slice(0, 40)) lines.push('  ' + item.id + ' - ' + item.description.slice(0, 100));
      if (items.length > 40) lines.push('  ... ' + (items.length - 40) + ' more (/memory search WORDS)');
      lines.push('Commands: /memory search WORDS, /memory show ID, /memory forget ID, /memory add NOTE, /memory path, /remember [focus]. Turn it off with "autoMemory": false in settings or OASIS_AUTO_MEMORY=0.');
      lines.push('Start a message with # to save a note to the project OASIS.md instead (for example: # always run npm test before committing).');
      return { output: lines.join('\n') };
    }
    case 'remember': {
      return {
        output: 'Reviewing this conversation for things worth remembering.',
        prompt: 'Review this conversation and save durable memories with memory_save' + (argument ? ', focusing on: ' + argument : '') + '. Good memories: preferences or corrections the user gave, decisions and their reasons, non-obvious project facts (build, test, deploy commands; where things live; gotchas), and lessons from fixes that took several attempts. Search existing memories first with memory_search and update them instead of adding duplicates; delete ones this conversation proved wrong. Skip secrets and one-off details. Finish with a short list of what you saved, updated or deleted.'
      };
    }
    case 'rewind': {
      const turns = session ? listCheckpoints(session) : [];
      if (!turns.length) return { output: 'Nothing to rewind yet. Checkpoints are recorded for each task in this session.' };
      if (!argument) {
        const lines = ['Recent turns (1 = most recent):'];
        for (const turn of turns.slice(0, 15)) lines.push('  ' + turn.number + '. ' + JSON.stringify(turn.prompt) + (turn.files.length ? '  files: ' + turn.files.slice(0, 6).join(', ') + (turn.files.length > 6 ? ', ...' : '') : '  (no file changes)'));
        lines.push('Use /rewind N to undo the last N turns (files and conversation), /rewind N code for files only, or /rewind N chat for the conversation only.');
        lines.push('Changes made by shell commands are not tracked.');
        return { output: lines.join('\n') };
      }
      const [countText, modeText = ''] = argument.split(/\s+/);
      const count = Number.parseInt(countText, 10);
      if (!Number.isInteger(count) || count < 1) return { output: 'Usage: /rewind N [code|chat]' };
      const mode = /^code$/i.test(modeText) ? 'code' : /^(chat|conversation)$/i.test(modeText) ? 'conversation' : 'both';
      const result = await rewind(session, count, mode);
      const lines = ['Rewound ' + result.turns + ' turn' + (result.turns === 1 ? '' : 's') + '.'];
      if (mode !== 'conversation') {
        lines.push('  Restored: ' + (result.restored.length ? result.restored.join(', ') : '(none)'));
        if (result.deleted.length) lines.push('  Removed new files: ' + result.deleted.join(', '));
        if (result.skipped.length) lines.push('  Could not restore (too large or unsafe): ' + result.skipped.join(', '));
      }
      if (mode !== 'code') lines.push(result.conversationUnavailable ? '  The conversation was compacted, so only files were restored.' : '  Removed ' + result.messagesRemoved + ' messages from the conversation.');
      return { output: lines.join('\n') };
    }
    default:
      return null;
  }
}

// /code-review (alias /review) options, as in Claude Code:
// [low|medium|high|xhigh|max|ultra] [--fix] [--comment] [--max-findings n|all|default] [pr#|branch|path]
export function parseReviewArgs(argument = '') {
  const words = String(argument || '').trim().split(/\s+/).filter(Boolean);
  const options = { effort: 'medium', fix: false, comment: false, maxFindings: null, target: '' };
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const lower = word.toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(lower) && !options.effortSet) { options.effort = lower; options.effortSet = true; }
    else if (lower === '--fix') options.fix = true;
    else if (lower === '--comment') options.comment = true;
    else if (lower === '--max-findings' || lower.startsWith('--max-findings=')) {
      const value = lower.includes('=') ? lower.split('=')[1] : (words[++i] || '').toLowerCase();
      options.maxFindings = value === 'all' ? Infinity : value === 'default' || !value ? null : Math.max(1, parseInt(value, 10) || 10);
    } else rest.push(word);
  }
  delete options.effortSet;
  options.target = rest.join(' ');
  return options;
}

function describeReviewTarget(argument) {
  const { target, effort } = parseReviewArgs(argument);
  const what = /^#?\d+$/.test(target) ? 'pull request #' + target.replace('#', '') : target ? target : 'the current uncommitted and branch changes';
  return what + (effort !== 'medium' ? ' (' + effort + ' effort)' : '');
}

const REVIEW_LENSES = [
  ['logic', 'logic and correctness: wrong conditions, off-by-one, inverted checks, broken invariants, wrong return values'],
  ['edge cases', 'edge cases and error handling: empty/null/huge inputs, failures of I/O and network calls, partial writes, unhandled rejections'],
  ['state and concurrency', 'state and concurrency: races, stale caches, ordering assumptions, resource leaks, cleanup on every path'],
  ['integration', 'integration: callers and callees of the changed code, API contracts, data formats, migrations, config, backwards compatibility'],
  ['tests', 'tests: whether the change is exercised, assertions that cannot fail, missing regression tests for the fixed behavior']
];

export function reviewPrompt(kind, argument = '') {
  const options = parseReviewArgs(argument);
  const target = options.target;
  let gather;
  if (/^#?\d+$/.test(target)) {
    const number = target.replace('#', '');
    gather = 'Review GitHub pull request #' + number + '. Use `gh pr view ' + number + '` and `gh pr diff ' + number + '` to read it.';
  } else if (target && /[\/.]/.test(target) && !/\.\./.test(target) && !/^origin\//.test(target)) {
    gather = 'Review `' + target + '` (a path: read the files there as they are now; if it is actually a branch or ref, review `git diff ' + target + '` instead).';
  } else if (target) {
    gather = 'Review the changes between `' + target + '` and the working tree. Use `git diff ' + target + '` and `git log --oneline ' + target + '..HEAD`.';
  } else {
    gather = 'Review the pending changes in this repository. Use `git status`, `git diff HEAD`, and, if the branch is ahead of its upstream or main, `git diff` against the merge base. Include untracked files.';
  }
  if (kind === 'security-review') {
    return [gather,
      'Focus only on security: injection (SQL, shell, path traversal, template), authentication and authorization gaps, secrets in code or logs, unsafe deserialization, SSRF, XSS/CSRF, insecure crypto or randomness, and risky dependency changes.',
      'Report only findings you are confident are exploitable or clearly dangerous; skip style and theoretical issues.',
      'For each finding give: severity (high/medium/low), file:line, the vulnerable code, an attack scenario, and a concrete fix.',
      'Do not modify any files; this is a read-only review. If there are no changes to review, say so.'].join('\n');
  }
  const lenses = { low: 0, medium: 0, high: 3, xhigh: 5, max: 5, ultra: 5 }[options.effort];
  const limit = options.maxFindings === Infinity ? 'Report every confirmed finding.' : 'Report at most ' + (options.maxFindings || (options.effort === 'low' ? 5 : 10)) + ' findings, most severe first' + (options.maxFindings ? '.' : ', and say how many lower-severity ones you left out.');
  const steps = [loadSkillInstruction('review') + 'follow its evidence-first workflow.', gather, 'Review correctness, security boundaries, performance, accessibility, and missing regression coverage. Treat current changes as read-only unless --fix was explicitly requested.'];
  if (options.effort === 'low') steps.push('Do one quick pass over the diff and flag only obvious bugs.');
  else if (!lenses) steps.push('Read the surrounding code when the diff alone is not enough, and check each suspected bug against the code before reporting it.');
  else {
    steps.push('Run ' + lenses + ' read-only review subagents in parallel with the task tool (one message, several task calls). Give each the same target and one lens:');
    for (const [name, text] of REVIEW_LENSES.slice(0, lenses)) steps.push('  - ' + name + ': ' + text);
    steps.push('Each reviewer returns candidate findings with file:line, the failing scenario and evidence from the code.');
    steps.push(options.effort === 'high' || options.effort === 'xhigh'
      ? 'Then merge duplicates and verify every candidate yourself by reading the code (and running a quick test or command when that settles it). Drop anything you cannot confirm.'
      : 'Then merge duplicates and verify every candidate with an independent verifier subagent per finding (in parallel) that tries to disprove it by reading the code and, where practical, running a test or a small script. Keep only findings the verifier confirms.');
  }
  steps.push(limit);
  steps.push('Record the final, confirmed findings with ONE report_findings call (file, line, severity critical/high/medium/low, category, summary, failure_scenario: the concrete input or sequence that breaks, and fix); pass findings: [] if nothing is wrong. Then reply with a one- or two-sentence summary instead of repeating the list. If report_findings is unavailable, list each finding with severity, file:line, what goes wrong and when, and the fix.');
  if (options.fix) steps.push('After the report, fix every confirmed finding with the smallest correct change, run the relevant tests, and list what you changed.');
  else steps.push('Do not modify any files; this is a read-only review.');
  if (options.comment) steps.push(/^#?\d+$/.test(target)
    ? 'Then post the findings on pull request #' + target.replace('#', '') + ': inline comments on the exact lines with `gh api repos/{owner}/{repo}/pulls/' + target.replace('#', '') + '/comments` where possible, plus a summary with `gh pr review ' + target.replace('#', '') + ' --comment --body ...`. Ask before posting if you are not auto-approved.'
    : 'Then post the findings on the pull request for the current branch (find it with `gh pr view --json number`): inline comments where possible, plus a summary with `gh pr review --comment`. If there is no pull request, say so and skip posting.');
  return steps.join('\n');
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part && (part.text || (part.type === 'image_url' ? '[image]' : ''))).filter(Boolean).join('\n');
  return content ? JSON.stringify(content) : '';
}

export function conversationMarkdown(session) {
  const lines = ['# Oasis conversation', '', 'Workspace: ' + session.root, 'Model: ' + (session.config && session.config.model || 'unknown'), 'Exported: ' + new Date().toISOString(), ''];
  for (const message of session.messages.slice(1)) {
    if (message.role === 'user') lines.push('## User', '', messageText(message.content), '');
    else if (message.role === 'assistant') {
      const text = messageText(message.content);
      if (text) lines.push('## Oasis', '', text, '');
      for (const call of message.tool_calls || []) lines.push('> Tool call: `' + (call.function && call.function.name) + '` ' + String(call.function && call.function.arguments || '').slice(0, 300), '');
    } else if (message.role === 'tool') {
      const text = messageText(message.content);
      lines.push('<details><summary>Tool result</summary>', '', '```', text.length > 2000 ? text.slice(0, 2000) + '\n... (truncated)' : text, '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

const UNIT_MS = { s: 1000, m: 60000, h: 3600000 };
// /loop [INTERVAL] [xN] PROMPT. Interval like 30s, 5m, 2h (default 10m, minimum 10s).
export function parseLoopArgs(argument) {
  const parts = String(argument || '').trim().split(/\s+/).filter(Boolean);
  let intervalMs = 10 * 60000;
  let times = null;
  const interval = parts[0] && parts[0].match(/^(\d+(?:\.\d+)?)([smh])$/i);
  // No interval: self-paced. The model picks each next wake with schedule_wakeup (default 10m if it does not).
  const selfPaced = !interval;
  if (interval) { intervalMs = Math.round(Number(interval[1]) * UNIT_MS[interval[2].toLowerCase()]); parts.shift(); }
  const count = parts[0] && parts[0].match(/^x(\d{1,3})$/i);
  if (count) { times = Number(count[1]); parts.shift(); }
  const prompt = parts.join(' ');
  if (!prompt) return { error: 'Usage: /loop [30s|5m|1h] [x5] PROMPT, for example /loop 5m check whether the deploy finished' };
  if (intervalMs < 10000) return { error: 'The shortest loop interval is 10s.' };
  if (intervalMs > 24 * 3600000) return { error: 'The longest loop interval is 24h.' };
  if (times !== null && times < 1) return { error: 'The run count must be at least 1.' };
  return selfPaced ? { intervalMs, times, prompt, selfPaced: true } : { intervalMs, times, prompt };
}

export function formatInterval(ms) {
  if (ms % 3600000 === 0) return ms / 3600000 + 'h';
  if (ms % 60000 === 0) return ms / 60000 + 'm';
  return Math.round(ms / 1000) + 's';
}
