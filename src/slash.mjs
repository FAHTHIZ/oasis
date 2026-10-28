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
import { listSessions } from './sessions.mjs';
import { setAdditionalDirectories } from './tools.mjs';
import { loadOutputStyles, applyOutputStyle } from './output-styles.mjs';
import { writeFile } from 'node:fs/promises';
import { listWorktrees } from './worktrees.mjs';
import { listAgentTeams } from './agent-tasks.mjs';
import path from 'node:path';

export const BUILTIN_COMMANDS = {
  help: 'Show built-in and custom commands',
  status: 'Show the model provider configuration',
  setup: 'Configure the model provider',
  clear: 'Start a fresh conversation',
  plan: 'Plan a task without writing files or running commands (/plan TASK)',
  compact: 'Summarize the conversation to free context (/compact [focus])',
  context: 'Show how much of the context window is in use',
  cost: 'Show token usage for this session',
  usage: 'Show token usage for this session (same as /cost)',
  effort: 'Show or set reasoning effort for this session (/effort [low|medium|high|max|auto])',
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
  review: 'Review changes for bugs (/review [PR number | git ref])',
  tasks: 'List background agents and processes (/tasks, /tasks ID, /tasks stop ID)',
  commit: 'Commit the current changes with a well-written message (/commit [hint])',
  pr: 'Create a branch if needed, commit, push, and open a pull request (/pr [base])',
  diagnostics: 'Run type checkers and linters, then fix errors (/diagnostics [paths])',
  'security-review': 'Security review of pending changes (/security-review [PR number | git ref])',
  copy: 'Copy the last reply (or the Nth most recent) to the clipboard (/copy [N])',
  fork: 'Fork the conversation: keep the original saved and continue in a copy (alias /branch)',
  branch: 'Fork the conversation (same as /fork)',
  skills: 'List available skills',
  remember: 'Save what is worth keeping from this conversation to auto memory (/remember [focus])',
  loop: 'Run a prompt now and again on an interval until Ctrl+C (/loop [5m] PROMPT)',
  cd: 'Switch the workspace to another directory and start a fresh conversation (/cd PATH)',
  sandbox: 'Show or change the OS sandbox for this session (/sandbox [on|off|network on|network off])',
  config: 'Show effective settings and where they come from',
  doctor: 'Check this workspace: tools, language servers, sandbox, settings, provider',
  'release-notes': 'Show recent changes to Oasis',
  export: 'Save this conversation as Markdown (/export [file])',
  resume: 'List saved sessions or resume one (/resume [ID])',
  goal: 'Keep working across turns until a condition is met (/goal CONDITION | clear)',
  btw: 'Ask a side question about this session without adding it to the conversation (/btw QUESTION)',
  recap: 'One-line summary of this session',
  rename: 'Name this session (/rename NAME)',
  simplify: 'Review changed code for reuse, simplicity, efficiency and abstraction, then apply fixes (/simplify [target])',
  verify: 'Build and run the app to confirm a change really works (/verify [what to check])',
  batch: 'Plan a large change as independent units and run them in parallel worktree subagents (/batch INSTRUCTION)',
  schedule: 'Schedule a prompt in this session (/schedule CRON PROMPT, /schedule list, /schedule delete ID)',
  'fewer-permission-prompts': 'Find safe read-only commands you approve often and add them to the project allowlist',
  keybindings: 'Show keyboard shortcuts',
  'terminal-setup': 'Set up Shift+Enter for newlines in your terminal',
  'privacy-settings': 'Show what Oasis sends where and how to turn things off',
  stop: 'Stop background agents and processes in this session',
  init: 'Create an OASIS.md project guide',
  exit: 'Leave Oasis'
};

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
  const { root, session, env = process.env, usage, sessionOptions = {} } = state;
  if (!state.sessionOptions) state.sessionOptions = sessionOptions;
  switch (name) {
    case 'help': {
      const custom = await loadCustomCommands(root, { env }).catch(() => new Map());
      const lines = ['Built-in commands:'];
      for (const [command, description] of Object.entries(BUILTIN_COMMANDS)) lines.push('  /' + command.padEnd(12) + ' ' + description);
      if (custom.size) {
        lines.push('Custom commands:');
        for (const command of custom.values()) lines.push('  /' + (command.name + (command.argumentHint ? ' ' + command.argumentHint : '')).padEnd(12) + ' ' + command.description + ' (' + command.scope + ')');
      }
      lines.push('Tips: mention files with @path, start a line with # to save a project memory, and say "install pnpm" for direct installs.');
      return { output: lines.join('\n') };
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
      const used = estimateTokens(session.messages);
      const windowSize = contextWindowSize(session.config, env);
      const percent = windowSize ? Math.round(used / windowSize * 100) : 0;
      const bar = '#'.repeat(Math.min(30, Math.round(percent * 0.3))).padEnd(30, '.');
      const system = estimateTokens([session.messages[0]]);
      const tools = Math.round(JSON.stringify(session.toolDefinitions || []).length / 4);
      return { output: [
        'Context: [' + bar + '] ' + percent + '% of ' + formatNumber(windowSize) + ' tokens',
        '  System prompt and project memory: ~' + formatNumber(system),
        '  Tool definitions (' + (session.toolDefinitions || []).length + '): ~' + formatNumber(tools),
        '  Conversation (' + (session.messages.length - 1) + ' messages): ~' + formatNumber(Math.max(0, used - system)),
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
      if (!argument) return { output: 'Model: ' + (session ? session.config.model : '(provider default; start a task first)') + '. Use /model MODEL_ID to switch for this session.' };
      // PreModelSwitch hooks can allow, deny, or ask; PostModelSwitch adds context for the next request.
      const previous = session ? session.config.model : null;
      if (session && hasHooks(session.hooks, 'PreModelSwitch')) {
        const pre = await runHooks('PreModelSwitch', { session_id: session.sessionId || 'unsaved', model: argument, previous_model: previous, source: 'slash_command' }, hookOptions(session, env));
        if (pre.blocked || pre.permissionDecision === 'deny') return { output: 'A PreModelSwitch hook blocked switching to ' + argument + ': ' + (pre.reason || 'no reason given') };
        if (pre.permissionDecision === 'ask' && typeof state.confirm === 'function' && !(await state.confirm('A hook asks you to confirm switching to ' + argument + '. Switch?'))) return { output: 'Model switch cancelled.' };
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
      if (!lines.length) return { output: 'No MCP servers connected. Add user servers with oasis mcp add, or project servers in .mcp.json.' };
      return { output: lines.join('\n') };
    }
    case 'review':
    case 'security-review': {
      const custom = await loadCustomCommands(root, { env }).catch(() => new Map());
      if (custom.has(name)) return null; // A project or user command with this name wins.
      return { output: 'Starting ' + (name === 'review' ? 'a code review' : 'a security review') + ' of ' + describeReviewTarget(argument) + '.', prompt: reviewPrompt(name, argument) };
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
    case 'keybindings': {
      const { SHORTCUTS_HELP } = await import('./line-editor.mjs');
      return { output: 'Keyboard shortcuts:\n' + SHORTCUTS_HELP.join('\n') + '\n  While a turn runs: Esc interrupts it, and anything you type is queued as the next message.' };
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
      return { output: '[loop] Running every ' + formatInterval(parsed.intervalMs) + (parsed.times ? ', ' + parsed.times + ' times' : '') + '. Press Ctrl+C to stop.', loop: parsed };
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

function describeReviewTarget(argument) {
  if (/^#?\d+$/.test(argument || '')) return 'pull request #' + argument.replace('#', '');
  if (argument) return 'changes since ' + argument;
  return 'the current uncommitted and branch changes';
}

export function reviewPrompt(kind, argument = '') {
  let gather;
  if (/^#?\d+$/.test(argument)) {
    const number = argument.replace('#', '');
    gather = 'Review GitHub pull request #' + number + '. Use `gh pr view ' + number + '` and `gh pr diff ' + number + '` to read it.';
  } else if (argument) {
    gather = 'Review the changes between `' + argument + '` and the working tree. Use `git diff ' + argument + '` and `git log --oneline ' + argument + '..HEAD`.';
  } else {
    gather = 'Review the pending changes in this repository. Use `git status`, `git diff HEAD`, and, if the branch is ahead of its upstream or main, `git diff` against the merge base.';
  }
  const focus = kind === 'security-review'
    ? ['Focus only on security: injection (SQL, shell, path traversal, template), authentication and authorization gaps, secrets in code or logs, unsafe deserialization, SSRF, XSS/CSRF, insecure crypto or randomness, and risky dependency changes.',
       'Report only findings you are confident are exploitable or clearly dangerous; skip style and theoretical issues.',
       'For each finding give: severity (high/medium/low), file:line, the vulnerable code, an attack scenario, and a concrete fix.']
    : ['Look for correctness bugs, edge cases, error handling, race conditions, performance problems, missing tests, and unclear code.',
       'Prioritize real problems over style nits. Read the surrounding code when the diff alone is not enough.',
       'Organize the result as: Summary, Issues (each with severity, file:line, explanation, and suggested fix), and Suggestions.'];
  return [gather, ...focus, 'Do not modify any files; this is a read-only review. If there are no changes to review, say so.'].join('\n');
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
  if (interval) { intervalMs = Math.round(Number(interval[1]) * UNIT_MS[interval[2].toLowerCase()]); parts.shift(); }
  const count = parts[0] && parts[0].match(/^x(\d{1,3})$/i);
  if (count) { times = Number(count[1]); parts.shift(); }
  const prompt = parts.join(' ');
  if (!prompt) return { error: 'Usage: /loop [30s|5m|1h] [x5] PROMPT, for example /loop 5m check whether the deploy finished' };
  if (intervalMs < 10000) return { error: 'The shortest loop interval is 10s.' };
  if (intervalMs > 24 * 3600000) return { error: 'The longest loop interval is 24h.' };
  if (times !== null && times < 1) return { error: 'The run count must be at least 1.' };
  return { intervalMs, times, prompt };
}

export function formatInterval(ms) {
  if (ms % 3600000 === 0) return ms / 3600000 + 'h';
  if (ms % 60000 === 0) return ms / 60000 + 'm';
  return Math.round(ms / 1000) + 's';
}
