/**
 * OASIS tool definition bridge.
 *
 * Converts existing OASIS tool definitions into Tool Kernel definitions.
 * This is the first non-breaking step toward routing agent tool dispatch
 * through the unified kernel.
 */

import { defineTool } from './tool-kernel.mjs';

const CAPABILITY_BY_TOOL = {
  git_status: ['git', 'read'],
  git_diff: ['git', 'read'],
  list_files: ['read'],
  read_file: ['read'],
  repo_map: ['read'],
  glob_files: ['read'],
  search_files: ['read'],
  write_file: ['write'],
  todo_write: ['write'],
  delete_file: ['write'],
  run_command: ['execute'],
  install_package: ['execute', 'network'],
  fetch_url: ['network'],
  edit_file: ['write'],
  list_skills: ['read'],
  load_skill: ['read'],
  read_skill_resource: ['read'],
  run_specialist_review: ['read'],
  install_extension: ['network', 'write'],
  configure_provider: ['network'],
  install_external_skill: ['network', 'write'],
  configure_mcp_server: ['mcp', 'execute'],
  connect_service: ['mcp', 'network'],
  add_extension: ['network', 'write'],
  install_plugin: ['write'],
  web_search: ['network'],
  run_shell: ['execute'],
  powershell: ['execute'],
  monitor: ['execute'],
  browser: ['browser', 'network'],
  multi_edit: ['write'],
  notebook_edit: ['write'],
  memory_save: ['write'],
  memory_delete: ['write'],
  memory_search: ['read'],
  memory_read: ['read'],
  session_search: ['read'],
  create_pull_request: ['git', 'network', 'write'],
  git_push: ['git', 'network', 'write'],
  git_commit: ['git', 'write'],
  git_branch: ['git', 'write'],
  worktree_merge: ['git', 'write']
};

const RISK_BY_TOOL = {
  read_file: 'low',
  list_files: 'low',
  repo_map: 'low',
  glob_files: 'low',
  search_files: 'low',
  git_status: 'low',
  git_diff: 'low',
  write_file: 'high',
  edit_file: 'high',
  delete_file: 'critical',
  run_command: 'critical',
  install_package: 'critical',
  configure_mcp_server: 'critical',
  install_extension: 'high',
  install_external_skill: 'high',
  add_extension: 'high',
  install_plugin: 'medium'
};

export function bridgeToolDefinition(definition, handler = {}) {
  const name = definition && definition.function && definition.function.name;
  if (!name) throw new Error('Tool definition is missing a function name.');
  return defineTool({
    name,
    title: handler.title || name,
    description: definition.function.description || '',
    capabilities: handler.capabilities ?? CAPABILITY_BY_TOOL[name] ?? (name.startsWith('mcp_') ? ['mcp', 'execute'] : ['execute']),
    risk: handler.risk ?? RISK_BY_TOOL[name] ?? (CAPABILITY_BY_TOOL[name] ? 'medium' : 'critical'),
    inputSchema: definition.function.parameters || {},
    outputSchema: handler.outputSchema || {},
    timeoutMs: handler.timeoutMs,
    requiresApproval: handler.requiresApproval ?? (name.startsWith('mcp_') || !CAPABILITY_BY_TOOL[name] ? true : ['delete_file', 'run_command', 'run_shell', 'powershell', 'monitor', 'install_package', 'configure_mcp_server', 'git_push', 'git_commit', 'create_pull_request'].includes(name)),
    run: handler.run || (async () => ({ bridged: true }))
  });
}

export function bridgeToolDefinitions(definitions, handlers = {}) {
  return definitions.map((definition) => bridgeToolDefinition(definition, handlers[definition.function.name] || {}));
}
