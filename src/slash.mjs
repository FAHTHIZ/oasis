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

export const BUILTIN_COMMANDS = {
  help: 'Show built-in and custom commands',
  status: 'Show the model provider configuration',
  setup: 'Configure the model provider',
  clear: 'Start a fresh conversation',
  plan: 'Plan a task without writing files or running commands (/plan TASK)',
  compact: 'Summarize the conversation to free context (/compact [focus])',
  context: 'Show how much of the context window is in use',
  cost: 'Show token usage for this session',
  model: 'Show or switch the model for this session (/model [id])',
  mode: 'Show or switch the permission mode (/mode ' + PERMISSION_MODES.join('|') + ')',
  permissions: 'Show permission rules, mode, and sandbox',
  agents: 'List available subagents',
  commands: 'List custom slash commands',
  hooks: 'List configured lifecycle hooks',
  bashes: 'List background processes',
  todos: 'Show the current todo list',
  memory: 'Show which memory files are loaded (use "# note" to add a project memory)',
  rewind: 'Undo recent turns: restore files and/or conversation (/rewind [N] [code|chat])',
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
        'Use /compact to summarize older turns.'
      ].join('\n') };
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
      if (session) session.permissions.setMode(argument);
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
