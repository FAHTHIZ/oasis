import { stdout } from 'node:process';
import { loadMcpServers, saveMcpServers, validateMcpServerConfig } from './mcp.mjs';
import { loadProjectMcpServers } from './mcp-project.mjs';
import { inspectGitHubExtension, inspectGitHubMcpServers, selectReviewedMcpServers, installGitHubExtension, updateGitHubExtension, rollbackGitHubExtension, listInstalledExtensions, removeGitHubExtension } from './extensions.mjs';
import { loadSettings } from './settings.mjs';

// `oasis mcp` and `oasis extensions` subcommands.
export async function manageMcp(rest, root = process.cwd(), { approve, askLine, askSecret } = {}) {
  const action = rest[0] || 'list';
  const config = await loadMcpServers();
  if (action === 'list') {
    stdout.write('MCP server configuration: ' + config.configPath + '\n');
    if (!config.servers.length) stdout.write('No servers in this file. Add one with oasis mcp add NAME -- COMMAND, or a remote one with oasis mcp add --transport http|sse NAME URL.\n');
    for (const server of config.servers) {
      stdout.write('  ' + server.name + ' — ' + (server.enabled ? 'enabled' : 'disabled') + '\n');
      stdout.write('    executable: ' + server.command + '\n');
      stdout.write('    args: ' + server.args.length + ' argument(s) (values hidden in this summary)\n');
      stdout.write('    explicit environment passthrough: ' + (server.passEnv.join(', ') || 'none') + '\n');
      if (server.origin) {
        stdout.write('    imported from: ' + server.origin.repository + '\n');
        stdout.write('    source revision: ' + server.origin.commitSha + '\n');
        stdout.write('    source manifest: ' + server.origin.filePath + '\n');
      }
    }
    const project = await loadProjectMcpServers(root, { env: process.env }).catch((error) => ({ servers: [], failures: [{ name: '.mcp.json', error: error.message }] }));
    if (project.servers.length || project.failures.length) {
      const trusted = (await loadSettings(root)).trusted;
      stdout.write('Project servers from .mcp.json' + (trusted ? '' : ' (ignored until you run oasis trust)') + ':\n');
      for (const server of project.servers) stdout.write('  ' + server.name + ' — ' + (server.type === 'http' || server.type === 'sse' ? server.type + ' ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of project.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
    }
    const { loadClaudeCodeMcpServers } = await import('./mcp-project.mjs');
    const claude = await loadClaudeCodeMcpServers(root, { env: process.env }).catch((error) => ({ local: [], user: [], failures: [{ name: '~/.claude.json', error: error.message }] }));
    const { loadUserMcpJson } = await import('./mcp-project.mjs');
    const userJson = await loadUserMcpJson({ env: process.env }).catch(() => ({ servers: [], failures: [] }));
    if (userJson.servers.length || userJson.failures.length) {
      stdout.write('User servers from ' + userJson.file + ':\n');
      for (const server of userJson.servers) stdout.write('  ' + server.name + ' — ' + (server.type === 'http' || server.type === 'sse' ? server.type + ' ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of userJson.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
    }
    if (claude.local.length || claude.user.length || claude.failures.length) {
      stdout.write('Claude Code servers from ' + (claude.file || '~/.claude.json') + ':\n');
      for (const server of [...claude.local, ...claude.user]) stdout.write('  ' + server.name + ' — ' + (server.source === 'claude-local' ? 'local' : 'user') + ' scope, ' + (server.type === 'http' || server.type === 'sse' ? server.type + ' ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of claude.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
    }
    stdout.write('Configured MCP servers start when a new agent session begins; each tool call asks for approval by default.\n');
    return;
  }
  if (action === 'serve') {
    const { serveMcp } = await import('./mcp-serve.mjs');
    await serveMcp({ root, args: rest.slice(1), env: process.env });
    return;
  }
  if (action === 'login' || action === 'logout') {
    if (!rest[1]) throw new Error('Usage: oasis mcp ' + action + ' NAME');
    const commands = await import('./mcp-auth-commands.mjs');
    stdout.write((action === 'login'
      ? await commands.mcpLogin(root, rest[1], { env: process.env, print: (text) => stdout.write(text + '\n') })
      : await commands.mcpLogout(root, rest[1], { env: process.env })) + '\n');
    return;
  }
  if (action === 'connect') {
    const { connectCommand } = await import('./connectors.mjs');
    const { openInBrowser } = await import('./mcp-oauth.mjs');
    const name = rest.slice(1).join(' ').trim();
    if (name && !askLine) throw new Error('oasis mcp connect needs an interactive terminal.');
    const final = await connectCommand(name, { root, env: process.env, write: (text) => stdout.write(text), askLine, askSecret, open: (url) => openInBrowser(url), width: stdout.columns || 80 });
    if (final && final.status === 'failed') process.exitCode = 1;
    return;
  }
  if (action === 'search') {
    const registry = await import('./mcp-registry.mjs');
    const query = rest.slice(1).filter((arg) => arg !== '--json').join(' ');
    const rows = await registry.searchRegistry(query, { env: process.env });
    stdout.write((rest.includes('--json') ? JSON.stringify(rows, null, 2) : registry.formatSearchResults(rows, query)) + '\n');
    return;
  }
  if (action === 'install') {
    const { installFromRegistry } = await import('./mcp-registry.mjs');
    stdout.write(await installFromRegistry(rest.slice(1), { root, env: process.env, approve: (text) => approve(text, true, false) }) + '\n');
    return;
  }
  if (action === 'add' && rest.some((arg, i) => arg === '--transport' && /^(?:http|sse|streamable-http)$/i.test(String(rest[i + 1] || '')) || /^--transport=(?:http|sse|streamable-http)$/i.test(arg))) {
    const { addRemoteMcpServer } = await import('./mcp-remote-add.mjs');
    const result = await addRemoteMcpServer(rest.slice(1), { root, env: process.env, approve: (text) => approve(text, true, false) });
    stdout.write(result + '\n');
    return;
  }
  if (action === 'add') {
    const name = rest[1];
    const separator = rest.indexOf('--');
    if (!name || separator < 2 || separator === rest.length - 1) {
      throw new Error('Usage: oasis mcp add NAME [--env VAR1,VAR2] -- EXECUTABLE [ARG ...]\n       oasis mcp add --transport http|sse NAME URL [--header "Name: value"] [--scope user|project]');
    }
    let passEnv = [];
    for (let i = 2; i < separator; i++) {
      if (rest[i] === '--env') {
        if (!rest[i + 1]) throw new Error('--env needs a comma-separated list of environment variable names.');
        passEnv = rest[++i].split(',').map((item) => item.trim()).filter(Boolean);
      } else {
        throw new Error('Unknown MCP option: ' + rest[i] + '. Supported option: --env VAR1,VAR2');
      }
    }
    const command = rest[separator + 1];
    const args = rest.slice(separator + 2);
    const entry = validateMcpServerConfig({ name, command, args, passEnv, enabled: true });
    const summary = 'Configure MCP server "' + name + '"?\nExecutable: ' + command + '\nArguments: ' + JSON.stringify(args) + '\nEnvironment passthrough: ' + (passEnv.join(', ') || 'none') + '\nThis starts third-party code inside your user account when Oasis sessions start. Review the server source and package identity before approving.';
    if (!(await approve(summary, true, false))) {
      stdout.write('MCP configuration cancelled. The previous configuration was kept.\n');
      return;
    }
    const output = await saveMcpServers(config.servers.filter((server) => server.name !== name).concat(entry), { configPath: config.configPath });
    stdout.write('Configured MCP server "' + name + '" in ' + output + '. It will start next time you run Oasis.\n');
    return;
  }
  if (action === 'remove') {
    const name = rest[1];
    if (!name) throw new Error('Usage: oasis mcp remove NAME');
    const existing = config.servers.find((server) => server.name === name);
    if (!existing) {
      const { removeUserMcpJsonServer } = await import('./mcp-remote-add.mjs');
      const removed = await removeUserMcpJsonServer(name, { env: process.env, approve: (text) => approve(text, true, false) });
      if (removed) { stdout.write(removed + '\n'); return; }
      throw new Error('No configured MCP server named "' + name + '". Project servers live in .mcp.json; edit that file to remove one.');
    }
    if (!(await approve('Remove MCP server "' + name + '" from the user-level configuration?', true, false))) {
      stdout.write('MCP removal cancelled.\n');
      return;
    }
    const output = await saveMcpServers(config.servers.filter((server) => server.name !== name), { configPath: config.configPath });
    stdout.write('Removed MCP server "' + name + '" from ' + output + '.\n');
    return;
  }
  if (action === 'enable' || action === 'disable') {
    const name = rest[1];
    const existing = config.servers.find((server) => server.name === name);
    if (!existing) throw new Error('No configured MCP server named "' + name + '".');
    if (!(await approve((action === 'enable' ? 'Enable' : 'Disable') + ' MCP server "' + name + '"?', true, false))) return;
    existing.enabled = action === 'enable';
    const output = await saveMcpServers(config.servers, { configPath: config.configPath });
    stdout.write('MCP server "' + name + '" is now ' + (existing.enabled ? 'enabled' : 'disabled') + '. Saved ' + output + '\n');
    return;
  }
  throw new Error('Unknown MCP action. Use oasis mcp list, search, install, add, remove, enable, or disable.');
}

export async function manageExternalExtensions(root, args, autoApprove, { approve } = {}) {
  const values = [...args];
  const action = String(values.shift() || 'list').toLowerCase();
  let scope = 'project';
  let selectedServerNames = null;
  let rollbackCommitSha = null;
  const positional = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--commit') {
      if (!values[i + 1]) throw new Error('--commit requires a full 40-character backup commit SHA.');
      rollbackCommitSha = values[++i];
    } else if (values[i].startsWith('--commit=')) {
      rollbackCommitSha = values[i].slice('--commit='.length);
    } else if (values[i] === '--servers') {
      if (!values[i + 1]) throw new Error('--servers requires a comma-separated list of MCP server names.');
      selectedServerNames = values[++i].split(',').map((name) => name.trim()).filter(Boolean);
    } else if (values[i].startsWith('--servers=')) {
      selectedServerNames = values[i].slice('--servers='.length).split(',').map((name) => name.trim()).filter(Boolean);
    } else if (values[i] === '--scope') {
      if (!values[i + 1]) throw new Error('--scope requires self, project, or both.');
      scope = values[++i];
    } else if (values[i].startsWith('--scope=')) {
      scope = values[i].slice('--scope='.length);
    } else positional.push(values[i]);
  }
  if (!['self', 'project', 'both'].includes(scope)) throw new Error('Scope must be self, project, or both.');
  if (action === 'list') {
    const data = await listInstalledExtensions({ root });
    stdout.write('Oasis external agent/skill extensions\n\n');
    if (!data.extensions.length) { stdout.write('No external extensions are installed yet.\n'); return; }
    for (const item of data.extensions) {
      stdout.write(item.name + ' [' + item.scope + '] — ' + item.importedFiles + ' Markdown prompt(s)\n');
      stdout.write('  Source: ' + item.source + '\n  Commit: ' + item.commitSha + '\n  License: ' + item.license + '\n');
      for (const command of item.commands || []) stdout.write('  Command: /' + command.alias + ' — ' + command.description + '\n');
      for (const backup of item.backups || []) stdout.write('  Rollback: ' + backup.commitSha + ' (verified backup)\n');
    }
    return;
  }
  if (action === 'inspect') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions inspect https://github.com/owner/repository');
    const report = await inspectGitHubExtension(url);
    stdout.write('Repository: ' + report.repository.fullName + '\n');
    stdout.write('Default branch: ' + report.repository.defaultBranch + '\n');
    stdout.write('Pinned commit: ' + report.repository.commitSha + '\n');
    stdout.write('License: ' + report.repository.license + '\n');
    stdout.write('Importable Markdown prompts: ' + report.importCount + (report.limited ? ' (bounded selection)' : '') + '\n');
    stdout.write('Executable/source files detected (not imported): ' + report.executableFilesDetected + '\n');
    stdout.write('Policy: ' + report.executionPolicy + '\n');
    stdout.write('\nImportable Markdown commands (registered as Oasis aliases after installation):\n');
    for (const command of report.commands || []) stdout.write('  /' + command.alias + ' [' + command.sourceFormat + '] — ' + command.sourcePath + '\n');
    if (!(report.commands || []).length) stdout.write('  None detected in supported Markdown command layouts.\n');
    stdout.write('\nNormalized adapter plan (detection does not activate features):\n');
    for (const adapter of report.compatibility.installPlan.adapters) {
      stdout.write('  ' + adapter.label + '\n');
      for (const item of adapter.capabilities) {
        stdout.write('    ' + item.id + ': ' + item.status + ' (' + item.count + ') — ' + item.detail + '\n');
      }
    }
    const mcpPlan = report.mcpImportPlan || { servers: [], skipped: [], sourceFiles: [] };
    stdout.write('\nMCP server proposals (not imported or started): ' + mcpPlan.servers.length + '\n');
    for (const server of mcpPlan.servers) {
      stdout.write('  ' + server.name + ' — ' + server.command + ' ' + JSON.stringify(server.args) + ' [disabled if imported]\n');
      if (server.sourceEnvKeys.length) stdout.write('    Environment variable names declared (values omitted): ' + server.sourceEnvKeys.join(', ') + '\n');
    }
    for (const item of mcpPlan.skipped) stdout.write('  Skipped ' + (item.name || item.sourcePath) + ': ' + item.reason + '\n');
    stdout.write('\nSample of prompt paths:\n');
    for (const file of report.files.slice(0, 30)) stdout.write('  ' + file.path + '\n');
    return;
  }
  if (action === 'update') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions update https://github.com/owner/repository --scope self|project|both');
    const report = await inspectGitHubExtension(url);
    const inventory = await listInstalledExtensions({ root });
    const selectedScopes = scope === 'both' ? ['self', 'project'] : [scope];
    const matches = inventory.extensions.filter((item) => item.source === report.repository.url && selectedScopes.includes(item.scope));
    const missing = selectedScopes.filter((itemScope) => !matches.some((item) => item.scope === itemScope));
    if (missing.length) throw new Error('This repository is not installed in scope(s): ' + missing.join(', ') + '. Install it in those scopes before updating.');
    stdout.write('Update review\n  Repository: ' + report.repository.fullName + '\n');
    for (const item of matches) stdout.write('  ' + item.scope + ': ' + item.commitSha + '\n');
    stdout.write('  New commit: ' + report.repository.commitSha + '\n');
    stdout.write('  Importable prompts: ' + report.importCount + '\n  Callable Markdown commands: ' + (report.commands || []).length + '\n');
    if (matches.every((item) => item.commitSha.toLowerCase() === report.repository.commitSha.toLowerCase())) {
      stdout.write('Already current; no files changed.\n'); return;
    }
    const approved = await approve(
      'Update ' + report.repository.fullName + ' in ' + scope + ' to reviewed commit ' + report.repository.commitSha +
      '? Oasis verifies existing file hashes, keeps the previous revision for rollback, and does not execute scripts or enable MCP servers.',
      false, autoApprove
    );
    if (!approved) { stdout.write('Update cancelled; the installed revision was not changed.\n'); return; }
    const result = await updateGitHubExtension(url, { root, scope, expectedCommit: report.repository.commitSha });
    if (result.alreadyCurrent) { stdout.write('Already current; no files changed.\n'); return; }
    stdout.write('Updated ' + result.extensionName + ' to ' + result.commitSha + '.\n');
    for (const backup of result.backups) stdout.write('  Rollback available: ' + backup.scope + ' revision ' + backup.commitSha + '\n');
    for (const command of result.commands || []) stdout.write('  Command alias: /' + command.alias + '\n');
    stdout.write('No repository scripts were executed; previous verified revision kept for rollback.\n');
    return;
  }
  if (action === 'rollback') {
    const name = String(positional[0] || '').toLowerCase();
    if (!name || !rollbackCommitSha) throw new Error('Usage: oasis extensions rollback NAME --commit FULL_SHA --scope self|project|both');
    if (!/^[a-f0-9]{40}$/i.test(rollbackCommitSha)) throw new Error('--commit must be a full 40-character backup commit SHA.');
    const scopes = scope === 'both' ? ['self', 'project'] : [scope];
    const inventory = await listInstalledExtensions({ root });
    const matching = inventory.extensions.filter((item) => item.name === name && scopes.includes(item.scope));
    const missing = scopes.filter((itemScope) => {
      const item = matching.find((entry) => entry.scope === itemScope);
      return !item || !(item.backups || []).some((backup) => backup.commitSha.toLowerCase() === rollbackCommitSha.toLowerCase());
    });
    if (missing.length) throw new Error('No intact backup of ' + rollbackCommitSha + ' is available in scope(s): ' + missing.join(', ') + '. Use oasis extensions list to view rollback revisions.');
    const approved = await approve(
      'Restore extension "' + name + '" to verified commit ' + rollbackCommitSha + ' in ' + scope +
      '? The currently active revision will be preserved as another rollback backup.',
      false, autoApprove
    );
    if (!approved) { stdout.write('Rollback cancelled; no extension was changed.\n'); return; }
    const result = await rollbackGitHubExtension({ root, scope, name, commitSha: rollbackCommitSha });
    if (result.alreadyCurrent) { stdout.write(name + ' is already at commit ' + result.commitSha + '.\n'); return; }
    stdout.write('Rolled back ' + name + ' to ' + result.commitSha + '.\n');
    for (const backup of result.backups || []) stdout.write('  Previous revision retained: ' + backup.scope + ' ' + backup.commitSha + '\n');
    return;
  }
  if (action === 'mcp-import') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions mcp-import https://github.com/owner/repository [--servers name1,name2]');
    const plan = await inspectGitHubMcpServers(url);
    stdout.write('MCP import review for ' + plan.repository + '\nCommit: ' + plan.commitSha + '\nSource files: ' + (plan.sourceFiles.join(', ') || 'none') + '\n\n');
    for (const server of plan.servers) {
      stdout.write('  ' + server.name + ' — ' + server.command + ' ' + JSON.stringify(server.args) + '\n');
      stdout.write('    State: disabled on import; environment values are not copied.' + (server.sourceEnvKeys.length ? ' Declared environment keys: ' + server.sourceEnvKeys.join(', ') : '') + '\n');
    }
    for (const skipped of plan.skipped) stdout.write('  Skipped ' + (skipped.name || skipped.sourcePath) + ': ' + skipped.reason + '\n');
    if (!plan.servers.length) { stdout.write('No supported local stdio MCP server declarations were found. Nothing was changed.\n'); return; }
    const selected = selectReviewedMcpServers(plan.servers, selectedServerNames);
    if (!selected.length) { stdout.write('No supported MCP servers were selected. Nothing was changed.\n'); return; }
    const existing = await loadMcpServers();
    const existingNames = new Set(existing.servers.map((server) => server.name));
    const collisions = selected.filter((server) => existingNames.has(server.name)).map((server) => server.name);
    if (collisions.length) throw new Error('MCP server names already configured: ' + collisions.join(', ') + '. Rename or remove them before importing.');
    if (existing.servers.length + selected.length > 40) throw new Error('The configured MCP server limit would be exceeded.');
    const approved = await approve(
      'Save ' + selected.length + ' MCP server configuration(s) from ' + plan.repository + ' at commit ' + plan.commitSha +
      '? They will be saved disabled; no process will start, and no environment values will be copied.',
      false,
      autoApprove
    );
    if (!approved) { stdout.write('MCP import cancelled; no configuration was changed.\n'); return; }
    // Re-fetch after approval. If the repository default branch changed while the
    // prompt was open, stop instead of importing commands that were not reviewed.
    const latestPlan = await inspectGitHubMcpServers(url, { expectedCommit: plan.commitSha });
    const latestSelected = selectReviewedMcpServers(latestPlan.servers, selected.map((server) => server.name));
    const latestConfig = await loadMcpServers();
    const latestNames = new Set(latestConfig.servers.map((server) => server.name));
    const lateCollisions = latestSelected.filter((server) => latestNames.has(server.name)).map((server) => server.name);
    if (lateCollisions.length) throw new Error('MCP server names were configured while approval was pending: ' + lateCollisions.join(', ') + '. Nothing was imported.');
    if (latestConfig.servers.length + latestSelected.length > 40) throw new Error('The configured MCP server limit would be exceeded. Nothing was imported.');
    const proposed = latestSelected.map((server) => ({ name: server.name, command: server.command, args: server.args, passEnv: [], enabled: false, origin: server.origin }));
    await saveMcpServers([...latestConfig.servers, ...proposed]);
    stdout.write('Imported ' + proposed.length + ' MCP configuration(s). All remain disabled; review environment variables, then enable trusted servers separately.\n');
    return;
  }
  if (action === 'install') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions install https://github.com/owner/repository --scope self|project|both');
    const report = await inspectGitHubExtension(url);
    stdout.write('Import plan\n  Repository: ' + report.repository.fullName + '\n  Commit: ' + report.repository.commitSha + '\n  Scope: ' + scope + '\n  Markdown prompts: ' + report.importCount + '\n  Detected executable/source files (ignored): ' + report.executableFilesDetected + '\n  License: ' + report.repository.license + '\n');
    const approved = await approve(
      'Import ' + report.importCount + ' Markdown prompt file(s) from ' + report.repository.fullName +
      ' at commit ' + report.repository.commitSha + ' into ' + scope +
      '? Oasis will not execute repository scripts, install packages, or enable MCP servers.',
      false,
      autoApprove
    );
    if (!approved) { stdout.write('Import cancelled; no extension files were installed.\n'); return; }
    const result = await installGitHubExtension(url, { root, scope, expectedCommit: report.repository.commitSha });
    stdout.write('\nImported ' + result.importedFiles + ' prompt file(s) from ' + result.repository.fullName + '.\n');
    for (const destination of result.destinations) stdout.write('  ' + destination.scope + ': ' + destination.path + '\n');
    stdout.write('Verification: pinned commit ' + result.commitSha + '; scripts executed: no; dependencies installed: no.\n');
    return;
  }
  if (action === 'remove' || action === 'uninstall') {
    const name = positional[0];
    if (!name) throw new Error('Usage: oasis extensions remove NAME --scope self|project');
    if (!['self', 'project'].includes(scope)) throw new Error('Remove accepts scope self or project, not both.');
    if (!(await approve('Remove the Oasis-managed "' + name + '" extension from scope "' + scope + '"? Any edited or unexpected files cause removal to be refused.', false, autoApprove))) {
      stdout.write('Removal cancelled.\n'); return;
    }
    const result = await removeGitHubExtension({ root, scope, name });
    stdout.write('Removed ' + result.name + ' from ' + result.scope + '.\n');
    return;
  }
  throw new Error('Unknown extensions action "' + action + '". Use list, inspect, install, or remove.');
}
