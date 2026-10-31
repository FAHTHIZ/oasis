// Plain tool schemas for power-tools.mjs, kept free of imports so tools.mjs can
// read them at module-evaluation time whichever module is imported first.
// Defined here (not in notebook.mjs) so module cycles cannot hit it before initialization.
export const NOTEBOOK_EDIT_DEFINITION = { type: 'function', function: { name: 'notebook_edit', description: 'Edit a Jupyter notebook (.ipynb) cell by cell. edit_mode replace (default) swaps a cell\'s source and clears its outputs, insert adds a new cell after cell_id (or at the top when cell_id is omitted), delete removes a cell. Use read_file on the notebook first to see cell ids. The original file is snapshotted first.', parameters: { type: 'object', properties: {
  path: { type: 'string', description: 'Workspace-relative .ipynb path' },
  cell_id: { type: 'string', description: 'Cell id from read_file, or cell-N for the N-th cell (0-based)' },
  new_source: { type: 'string', description: 'New cell source (ignored for delete)' },
  cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Required for insert; optional for replace' },
  edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] }
}, required: ['path'] } } };

export const POWER_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a regular expression (ripgrep syntax). Respects .gitignore when ripgrep is installed and always skips secret files. Use output_mode files_with_matches to find files, content to see matching lines, count for per-file counts.', parameters: { type: 'object', properties: {
    pattern: { type: 'string', description: 'Regular expression to search for' },
    path: { type: 'string', description: 'Workspace-relative file or directory to search; default .' },
    glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.ts or src/**/*.mjs' },
    ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
    context: { type: 'integer', description: 'Lines of context around each match (content mode), 0-10' },
    output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default content' },
    multiline: { type: 'boolean', description: 'Allow patterns to span lines' },
    limit: { type: 'integer', description: 'Maximum result lines, 1-500; default 200' }
  }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'multi_edit', description: 'Apply several exact-string replacements to ONE existing file in order. Either every edit applies or none do. Each old_string must be unique unless replace_all is true. The original file is snapshotted first.', parameters: { type: 'object', properties: {
    path: { type: 'string', description: 'Workspace-relative file path' },
    edits: { type: 'array', maxItems: 50, items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } }
  }, required: ['path', 'edits'] } } },
  NOTEBOOK_EDIT_DEFINITION,
  { type: 'function', function: { name: 'command_output', description: 'Read new stdout/stderr from a background process started with run_command run_in_background=true, plus whether it is still running and its exit code.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Background process id' }, filter: { type: 'string', description: 'Optional regex; only return matching lines' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'kill_command', description: 'Stop a background process started by run_command run_in_background=true.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Background process id' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_background', description: 'List background processes in this session with their status.', parameters: { type: 'object', properties: {} } } }
];

export const SHELL_TOOL_DEFINITION = { type: 'function', function: { name: 'run_shell', description: 'Run a shell command line with pipes, &&, redirects, and globbing in the workspace. Only available when the user enabled shell access or the OS sandbox. Requires approval unless a permission rule or the sandbox allows it. Prefer run_command for single programs.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command line' }, timeoutSeconds: { type: 'integer', description: '5-600; default 120' }, run_in_background: { type: 'boolean', description: 'Start without waiting; read with command_output' }, max_seconds: { type: 'integer', description: 'With run_in_background: stop automatically after this many seconds' } }, required: ['command'] } } };

export const POWERSHELL_TOOL_DEFINITION = { type: 'function', function: { name: 'powershell', description: 'Run a PowerShell command in the workspace (pwsh 7+, or Windows PowerShell 5.1). Use it for Windows-native work, PowerShell scripts and cmdlets. Profiles are not loaded. Requires approval unless a PowerShell(...) permission rule allows it.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell command' }, timeoutSeconds: { type: 'integer', description: '5-600; default 120' }, run_in_background: { type: 'boolean', description: 'Start without waiting; read with command_output' } }, required: ['command'] } } };
export const POWER_TOOL_NAMES = new Set(['grep', 'multi_edit', 'notebook_edit', 'command_output', 'kill_command', 'list_background', 'run_shell', 'powershell']);
