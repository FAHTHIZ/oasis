import { redactApprovalSecrets } from './approval-language.mjs';

const READ_TOOLS = new Set(['read_file', 'read_notebook', 'notebook_read', 'list_files', 'list_directory']);
const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'notebook_edit', 'apply_patch']);
const COMMAND_TOOLS = new Set(['run_command', 'run_shell', 'powershell', 'auto_test']);
const SEARCH_TOOLS = new Set(['search_files', 'grep', 'ast_grep', 'glob_files', 'repo_map']);
const REVIEW_TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'diagnostics', 'ide_get_diagnostics', 'security_scan']);
const WEB_TOOLS = new Set(['web_search', 'fetch_url']);

function text(value, limit = 240) {
  return redactApprovalSecrets(String(value == null ? '' : value).replace(/[\r\n\0]+/g, ' ').trim()).slice(0, limit);
}

function fileName(value) {
  const path = text(value, 500).replace(/\\/g, '/');
  return path ? path.split('/').filter(Boolean).at(-1) || path : '';
}

function commandText(args) {
  const command = text(args && args.command, 400);
  const list = Array.isArray(args && args.args) ? args.args.map((part) => text(part, 200)) : [];
  return [command, ...list].filter(Boolean).join(' ');
}

export function toolActivityCategory(name) {
  const tool = String(name || '').toLowerCase();
  if (READ_TOOLS.has(tool)) return 'read';
  if (tool === 'write_file') return 'write';
  if (tool === 'delete_file') return 'delete';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (COMMAND_TOOLS.has(tool)) return 'command';
  if (SEARCH_TOOLS.has(tool)) return 'search';
  if (REVIEW_TOOLS.has(tool)) return 'review';
  if (WEB_TOOLS.has(tool)) return 'web';
  return 'other';
}

const EXTRA_LABELS = {
  browser: 'Used the browser', command_output: 'Checked a running command', kill_command: 'Stopped a running command',
  list_background: 'Checked background tasks', git_branch: 'Managed branches', git_commit: 'Made a commit', git_push: 'Pushed the branch',
  create_pull_request: 'Opened a pull request', worktree_inspect: 'Checked the review copy', worktree_merge: 'Merged the review copy',
  advisor: 'Asked the advisor model', run_specialist_review: 'Ran a specialist review', install_extension: 'Installed an extension',
  add_extension: 'Added an extension', install_external_skill: 'Installed a skill', install_plugin: 'Installed a plugin', plugins: 'Checked plugins',
  configure_mcp_server: 'Set up a tool server', configure_provider: 'Set up a model provider', mcp: 'Checked tool servers',
  list_directory: 'Listed a folder', read_notebook: 'Read a notebook', notebook_read: 'Read a notebook'
};
// Unknown tools still say what ran: 'mcp__context7__resolve-library-id' → 'Used context7: resolve library id'.
function fallbackToolLabel(name) {
  const words = (value) => String(value).replace(/[_-]+/g, ' ').trim();
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return 'Used ' + words(mcp[1]) + ': ' + words(mcp[2]);
  if (name.startsWith('mcp_')) return 'Used a connected tool: ' + words(name.slice(4));
  return name ? 'Used ' + words(name) : 'Completed a project step';
}
export function labelToolActivity(name, args = {}, result = null) {
  const tool = String(name || '').toLowerCase();
  const path = fileName(args && (args.path || args.file_path || args.notebook_path));
  const focus = Array.isArray(args && args.focus) ? args.focus.join(', ') : '';
  const query = text(args && (args.query || args.pattern || focus), 100);
  if (tool === 'read_file' || tool === 'read_notebook' || tool === 'notebook_read') return path ? 'Read ' + path : 'Read a file';
  if (tool === 'edit_file' || tool === 'multi_edit' || tool === 'notebook_edit' || tool === 'apply_patch') return path ? 'Edited ' + path : 'Edited a file';
  if (tool === 'write_file') {
    const created = result && typeof result === 'object' && (result.created === true || result.backedUpExistingFile === false);
    return (created ? 'Created ' : 'Wrote ') + (path || 'a file');
  }
  if (tool === 'delete_file') return path ? 'Deleted ' + path : 'Deleted a file';
  if (tool === 'run_command' || tool === 'run_shell' || tool === 'powershell' || tool === 'auto_test') {
    if (args && args.run_in_background) return 'Started a background task';
    const command = commandText(args);
    if (/\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test|check|vitest|jest|playwright|mocha)\b|\bnode\s+--test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/i.test(command) ||
        (tool === 'auto_test' && /test|check|lint|build/i.test(command))) return 'Ran the tests';
    return 'Ran a command';
  }
  if (tool === 'ast_grep') return query ? "Searched code structure for '" + query + "'" : 'Searched code structure';
  if (tool === 'search_files' || tool === 'grep') return query ? "Searched for '" + query + "'" : 'Searched the project';
  if (tool === 'glob_files') return query ? 'Found files matching ' + query : 'Found matching files';
  if (tool === 'repo_map') return 'Mapped the project files';
  if (tool === 'fetch_url' || tool === 'web_search') return 'Looked up information online';
  if (tool === 'git_status') return 'Checked project changes';
  if (tool === 'git_diff') return 'Reviewed the diff';
  if (tool === 'git_log') return 'Reviewed recent project history';
  if (tool === 'task') {
    const type = text(args && args.subagent_type, 40);
    return (args && args.run_in_background ? 'Started ' : 'Ran ') + (type && type !== 'general-purpose' ? 'the ' + type + ' agent' : 'a subagent');
  }
  if (tool === 'agent_status') return 'Checked on subagents';
  if (tool === 'send_message') return 'Sent a message to a subagent';
  if (tool === 'agent_stop') return 'Stopped a subagent';
  if (tool === 'ask_user_question') return 'Asked you a question';
  if (tool === 'exit_plan_mode') return 'Presented a plan';
  if (tool === 'todo_write') return 'Updated the task plan';
  if (tool === 'lsp') return 'Checked code with the language server';
  if (tool === 'load_skill' || tool === 'list_skills' || tool === 'read_skill_resource') return 'Used a skill';
  if (tool === 'memory_search' || tool === 'memory_read') return 'Checked saved memory';
  if (tool === 'memory_save' || tool === 'memory_delete') return 'Updated saved memory';
  if (tool === 'memory_verify') return 'Checked saved memory';
  if (tool === 'diagnostics' || tool === 'ide_get_diagnostics') return 'Checked for code issues';
  if (tool === 'security_scan') return 'Ran the security scanners';
  if (tool === 'install_package') return 'Prepared a package installation';
  if (EXTRA_LABELS[tool]) return EXTRA_LABELS[tool];
  return fallbackToolLabel(tool);
}

export function safeToolActivityArgs(args) {
  let serialized;
  try { serialized = JSON.stringify(args && typeof args === 'object' ? args : {}); }
  catch { serialized = '{}'; }
  try { return JSON.parse(redactApprovalSecrets(serialized)); }
  catch { return {}; }
}

export function toolActivityStatus(result) {
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = { output: value }; }
  }
  if (!value || typeof value !== 'object') return 'success';
  if (value.error || value.isError === true || value.failed === true || value.passed === false ||
      value.timedOut === true || value.success === false ||
      (Number.isInteger(value.exitCode) && value.exitCode !== 0)) return 'error';
  if (value.approved === false || value.blocked === true || value.warning ||
      (Array.isArray(value.warnings) && value.warnings.length)) return 'warning';
  return 'success';
}

// A preview is offered only after a file-changing tool reports an actual change.
// Paths are workspace-relative; the browser revalidates them before reading.
export function toolActivityArtifacts(name, args = {}, result = null) {
  const tool = String(name || '').toLowerCase();
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (!value || typeof value !== 'object' || toolActivityStatus(value) === 'error') return [];
  let action = '';
  if (tool === 'write_file' && Number.isFinite(value.writtenBytes)) {
    action = value.backedUpExistingFile === true ? 'updated' : 'created';
  } else if (tool === 'edit_file' && value.changed === true) {
    action = 'updated';
  } else if (tool === 'notebook_edit' && (value.changed === true || value.edited === true)) {
    action = 'updated';
  }
  if (!action) return [];
  const candidates = [value.path, args && (args.path || args.file_path || args.notebook_path)];
  const seen = new Set();
  const artifacts = [];
  for (const candidate of candidates) {
    const displayPath = text(candidate, 500).replace(/\\/g, '/');
    if (!displayPath || displayPath === '.' || seen.has(displayPath)) continue;
    seen.add(displayPath);
    artifacts.push({ path: displayPath, action });
    if (artifacts.length >= 4) break;
  }
  return artifacts;
}

export function toolActivityWarning(result) {
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = { output: value }; }
  }
  if (!value || typeof value !== 'object') return '';
  const detail = text(value.error || value.warning || value.message || '', 700);
  if (value.error) return detail ? 'This step failed: ' + detail : 'This step failed.';
  if (value.approved === false) return detail ? 'This action was not approved: ' + detail : 'This action was not approved; no changes were made.';
  if (value.blocked === true) return detail ? 'This action was blocked: ' + detail : 'This action was blocked by a workspace rule.';
  if (typeof value.warning === 'string' && value.warning.trim()) return detail || 'This step returned a warning.';
  if (value.isError === true || value.failed === true || value.passed === false) return detail ? 'This step did not complete successfully: ' + detail : 'This step did not complete successfully.';
  if (value.timedOut === true) return 'The command timed out before it finished.';
  if (Number.isInteger(value.exitCode) && value.exitCode !== 0) {
    return 'The command failed (exit code ' + value.exitCode + ')' + (detail ? ': ' + detail : '.');
  }
  if (value.exitCodeWarning) return text(value.exitCodeWarning, 700);
  if (Array.isArray(value.warnings) && value.warnings.length) return text(value.warnings.join(' · '), 700);
  const logWarnings = [value.output, value.stdout, value.stderr]
    .filter((part) => typeof part === 'string')
    .flatMap((part) => part.split(/\r?\n/))
    .filter((line) => /\bwarning\b|verification incomplete|test.{0,24}weaken|weaken.{0,24}test/i.test(line));
  if (logWarnings.length) return text(logWarnings.slice(0, 3).join(' · '), 700);
  return '';
}
