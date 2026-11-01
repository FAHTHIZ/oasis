import { redactApprovalSecrets } from './approval-language.mjs';

const READ_TOOLS = new Set(['read_file', 'read_notebook', 'notebook_read', 'list_files', 'list_directory']);
const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'notebook_edit', 'write_file', 'delete_file', 'apply_patch']);
const COMMAND_TOOLS = new Set(['run_command', 'run_shell', 'powershell', 'auto_test']);
const SEARCH_TOOLS = new Set(['search_files', 'grep', 'glob_files', 'repo_map']);

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
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (COMMAND_TOOLS.has(tool)) return 'command';
  if (SEARCH_TOOLS.has(tool)) return 'search';
  return 'other';
}

export function labelToolActivity(name, args = {}, result = null) {
  const tool = String(name || '').toLowerCase();
  const path = fileName(args && (args.path || args.file_path || args.notebook_path));
  const focus = Array.isArray(args && args.focus) ? args.focus.join(', ') : '';
  const query = text(args && (args.query || args.pattern || focus), 100);
  if (tool === 'read_file' || tool === 'read_notebook' || tool === 'notebook_read') return path ? 'Read ' + path : 'Read a file';
  if (tool === 'edit_file' || tool === 'multi_edit' || tool === 'notebook_edit' || tool === 'apply_patch') return path ? 'Edited ' + path : 'Edited a file';
  if (tool === 'write_file') {
    const created = result && typeof result === 'object' && result.created === true;
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
  if (tool === 'search_files' || tool === 'grep') return query ? "Searched for '" + query + "'" : 'Searched the project';
  if (tool === 'glob_files') return query ? 'Found files matching ' + query : 'Found matching files';
  if (tool === 'repo_map') return 'Mapped the project files';
  if (tool === 'fetch_url' || tool === 'web_search') return 'Looked up information online';
  if (tool === 'git_status') return 'Checked project changes';
  if (tool === 'git_diff') return 'Reviewed a file comparison';
  if (tool === 'git_log') return 'Reviewed recent project history';
  if (tool === 'task') return 'Asked a helper to investigate';
  if (tool === 'diagnostics' || tool === 'ide_get_diagnostics') return 'Checked for code issues';
  if (tool === 'install_package') return 'Prepared a package installation';
  const friendly = text(tool.replace(/[_-]+/g, ' '), 100);
  return friendly ? friendly[0].toUpperCase() + friendly.slice(1) : 'Completed a project step';
}

export function safeToolActivityArgs(args) {
  let serialized;
  try { serialized = JSON.stringify(args && typeof args === 'object' ? args : {}); }
  catch { serialized = '{}'; }
  try { return JSON.parse(redactApprovalSecrets(serialized)); }
  catch { return {}; }
}

export function toolActivityWarning(result) {
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = { output: value }; }
  }
  if (!value || typeof value !== 'object') return '';
  const detail = text(value.error || value.warning || value.message || '', 700);
  if (value.error) return detail ? 'This step failed: ' + detail : 'This step failed.';
  if (value.isError === true || value.failed === true || value.passed === false) return detail ? 'This step did not complete successfully: ' + detail : 'This step did not complete successfully.';
  if (value.timedOut === true) return 'The command timed out before it finished.';
  if (Number.isInteger(value.exitCode) && value.exitCode !== 0) {
    return 'The command failed (exit code ' + value.exitCode + ')' + (detail ? ': ' + detail : '.');
  }
  if (value.exitCodeWarning) return text(value.exitCodeWarning, 700);
  if (Array.isArray(value.warnings) && value.warnings.length) return text(value.warnings.join(' · '), 700);
  return '';
}
