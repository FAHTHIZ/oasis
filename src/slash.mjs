// Built-in interactive slash commands (Claude Code style). Each handler returns
// { output } text, and optionally { prompt } to send to the agent, or
// { resetSession: true } when the caller should drop the current session.
import { compactHistoryIfNeeded } from './agent.mjs';
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
  worktrees: 'List subagent worktree branches waiting for review',
  commands: 'List custom slash commands',
  hooks: 'List configured lifecycle hooks',
  bashes: 'List background processes',
  mcp: 'Show connected MCP servers and their tools',
  'add-dir': 'Add a working directory for this session (/add-dir PATH)',
  'output-style': 'Show or switch the output style (/output-style [default|explanatory|learning|custom])',
  todos: 'Show the current todo list',
  memory: 'Show which memory files are loaded (use "# note" to add a project memory)',
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
  loop: 'Run a prompt now and again on an interval until Ctrl+C (/loop [5m] PROMPT)',
  cd: 'Switch the workspace to another directory and start a fresh conversation (/cd PATH)',
  sandbox: 'Show or change the OS sandbox for this session (/sandbox [on|off|network on|network off])',
  config: 'Show effective settings and where they come from',
  doctor: 'Check this workspace: tools, language servers, sandbox, settings, provider',
  'release-notes': 'Show recent changes to Oasis',
  export: 'Save this conversation as Markdown (/export [file])',
  resume: 'List saved sessions or resume one (/resume [ID])',
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
    case 'worktrees': {
      const items = await listWorktrees(root, { env });
      if (!items.length) return { output: 'No subagent worktrees. Ask for parallel work with isolation "worktree" to get one branch per agent.' };
      return { output: ['Subagent worktrees:', ...items.map((item) => '  ' + (item.branch || '(detached)').padEnd(36) + ' ' + item.relative), 'Review: git diff HEAD...BRANCH   Merge: git merge BRANCH   Remove: git worktree remove PATH && git branch -D BRANCH'].join('\n') };
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
      return { output: 'Session usage: ' + formatNumber(u.totalTokens) + ' tokens (' + formatNumber(u.inputTokens) + ' input, ' + formatNumber(u.outputTokens) + ' output) across ' + u.requests + ' model requests and ' + u.turns + ' turns.' };
    }
    case 'model': {
      if (!argument) return { output: 'Model: ' + (session ? session.config.model : '(provider default; start a task first)') + '. Use /model MODEL_ID to switch for this session.' };
      sessionOptions.model = argument;
      if (session) session.config = { ...session.config, model: argument };
      return { output: 'Model for this session set to ' + argument + '.' };
    }
    case 'mode': {
      const current = session ? session.permissions.mode : (sessionOptions.permissionMode || 'default');
      if (!argument) return { output: 'Permission mode: ' + current + '. Options: ' + PERMISSION_MODES.join(', ') + '.' };
      if (!PERMISSION_MODES.includes(argument)) return { output: 'Unknown mode. Options: ' + PERMISSION_MODES.join(', ') + '.' };
      sessionOptions.permissionMode = argument;
      if (session) {
        if (argument === 'plan' && session.permissions.mode !== 'plan') session.prePlanMode = session.permissions.mode;
        session.permissions.setMode(argument);
      }
      return { output: 'Permission mode set to ' + argument + '.' };
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
      for (const [event, groups] of entries) for (const group of groups) for (const hook of group.hooks) lines.push(event + (group.matcher ? ' [' + group.matcher + ']' : '') + ': ' + hook.command);
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
      return { output: 'Added ' + result.accepted.at(-1) + ' for this session.' };
    }
    case 'mcp': {
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
      if (!log || !log.ok || !log.commits.length) return { output: 'Release notes: https://github.com/gtxnrg-ship-it/Oasis/commits/main (this install has no Git history). Update with oasis update.' };
      return { output: ['Recent Oasis changes:', ...log.commits.map((c) => '  ' + c.date + '  ' + c.subject), 'Full history: https://github.com/gtxnrg-ship-it/Oasis/commits/main'].join('\n') };
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
      const files = await memoryFiles(root, { env });
      const lines = files.map((file) => (file.exists ? '[loaded] ' : '[none]   ') + file.label + ': ' + file.path);
      lines.push('Start a message with # to save a note to the project OASIS.md (for example: # always run npm test before committing).');
      return { output: lines.join('\n') };
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
