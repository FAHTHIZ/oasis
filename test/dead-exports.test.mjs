import test from 'node:test';
import assert from 'node:assert/strict';

// Exports removed as dead code: nothing in the repo imported them. The modules must still load.
const REMOVED = {
  '../app/core/timeline.mjs': ['STEP_KINDS'],
  '../src/frontmatter.mjs': ['stringifyYaml'],
  '../src/monitors.mjs': ['MONITOR_TOOL_DEFINITION'],
  '../src/power-tools.mjs': ['NOTEBOOK_EDIT_DEFINITION', 'POWER_TOOL_DEFINITIONS', 'POWER_TOOL_NAMES']
};

for (const [file, names] of Object.entries(REMOVED)) {
  test(`${file} loads without its dead exports`, async () => {
    const mod = await import(file);
    for (const name of names) assert.equal(name in mod, false, `${name} is still exported`);
  });
}

test('power-tools still re-exports the shell tool definitions agent.mjs uses', async () => {
  const mod = await import('../src/power-tools.mjs');
  assert.equal(mod.SHELL_TOOL_DEFINITION.function.name, 'run_shell');
  assert.ok(mod.POWERSHELL_TOOL_DEFINITION);
});

// Modules whose module-internal helpers lost their `export` keyword: each must still load.
const UNEXPORTED_MODULES = [
  '../app/core/agent.mjs',
  '../app/core/claude-plugins.mjs',
  '../app/core/connect.mjs',
  '../app/core/providers.mjs',
  '../app/core/sandbox.mjs',
  '../desktop/permissions.mjs',
  '../src/add-anything.mjs',
  '../src/agent-ignore.mjs',
  '../src/agent-tasks.mjs',
  '../src/ai-comments.mjs',
  '../src/api-key-helper.mjs',
  '../src/app-server.mjs',
  '../src/app-update.mjs',
  '../src/apply-patch.mjs',
  '../src/artifacts.mjs',
  '../src/attention.mjs',
  '../src/auto-memory.mjs',
  '../src/auto-mode.mjs',
  '../src/cdp.mjs',
  '../src/change-guard.mjs',
  '../src/channels.mjs',
  '../src/checkpoints.mjs',
  '../src/cli-routines.mjs',
  '../src/cli-setup.mjs',
  '../src/cloud-providers.mjs',
  '../src/cloud.mjs',
  '../src/code-mode.mjs',
  '../src/codex-app-server-ws.mjs',
  '../src/codex-app-server.mjs',
  '../src/compaction-history.mjs',
  '../src/completion.mjs',
  '../src/context-window.mjs',
  '../src/cursor-agents-api.mjs',
  '../src/deploy.mjs',
  '../src/diagnostics.mjs',
  '../src/eval.mjs',
  '../src/event-stream.mjs',
  '../src/fallback-chain.mjs',
  '../src/file-state.mjs',
  '../src/file-watch.mjs',
  '../src/followups.mjs',
  '../src/gateway-core.mjs',
  '../src/github-action.mjs',
  '../src/github-release.mjs',
  '../src/goose-recipes.mjs',
  '../src/hardware.mjs',
  '../src/headless.mjs',
  '../src/hooks.mjs',
  '../src/html-markdown.mjs',
  '../src/ide.mjs',
  '../src/idle-compaction.mjs',
  '../src/images.mjs',
  '../src/importers.mjs',
  '../src/insights.mjs',
  '../src/keybindings.mjs',
  '../src/line-editor.mjs',
  '../src/live-diff.mjs',
  '../src/loopback-fetch.mjs',
  '../src/lsp.mjs',
  '../src/markdown.mjs',
  '../src/mcp-extras.mjs',
  '../src/mcp-project.mjs',
  '../src/mcp-registry.mjs',
  '../src/mcp-serve.mjs',
  '../src/mcp.mjs',
  '../src/media-output.mjs',
  '../src/memory.mjs',
  '../src/mermaid-ascii.mjs',
  '../src/model-budgets.mjs',
  '../src/model-switch.mjs',
  '../src/models-command.mjs',
  '../src/monitors.mjs',
  '../src/network-doctor.mjs',
  '../src/output-styles.mjs',
  '../src/package-vetting.mjs',
  '../src/permissions.mjs',
  '../src/plugin-eval.mjs',
  '../src/presets.mjs',
  '../src/pricing.mjs',
  '../src/profiles.mjs',
  '../src/project-profile.mjs',
  '../src/prompt-tools.mjs',
  '../src/protected-paths.mjs',
  '../src/provider-retry.mjs',
  '../src/read-dedup.mjs',
  '../src/read-only-commands.mjs',
  '../src/remote-access.mjs',
  '../src/reply-language.mjs',
  '../src/repo-map.mjs',
  '../src/rule-refresh.mjs',
  '../src/safe-http.mjs',
  '../src/sandbox.mjs',
  '../src/scope-lock.mjs',
  '../src/secret-shield.mjs',
  '../src/session-messaging.mjs',
  '../src/session-tools.mjs',
  '../src/shell-completion.mjs',
  '../src/shell-risk.mjs',
  '../src/sleep-guard.mjs',
  '../src/sounds.mjs',
  '../src/ssh-backend.mjs',
  '../src/style-rules.mjs',
  '../src/subagent-support.mjs',
  '../src/subagents.mjs',
  '../src/telemetry.mjs',
  '../src/themes.mjs',
  '../src/tool-results.mjs',
  '../src/trajectories.mjs',
  '../src/turn-guards.mjs',
  '../src/update.mjs',
  '../src/voice.mjs',
  '../src/web-access.mjs',
  '../src/web-preview.mjs',
  '../src/worktrees.mjs',
];

test('modules with un-exported internal helpers still load', async () => {
  for (const file of UNEXPORTED_MODULES) await import(file);
});

test('internal helpers are no longer part of the module surface', async () => {
  assert.equal('runtimeSource' in await import('../app/core/sandbox.mjs'), false);
  assert.equal('tokenAt' in await import('../src/completion.mjs'), false);
  assert.equal('worktreeSlug' in await import('../src/worktrees.mjs'), false);
  assert.equal('redactSecretValues' in await import('../src/secret-shield.mjs'), false);
  assert.equal('FALLBACK_PROVIDERS' in await import('../src/fallback-chain.mjs'), false);
});

test('VS Code extension modules export only what the extension and tests require', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  assert.deepEqual(Object.keys(require('../ide/vscode/src/server.js')), ['startIdeServer']);
  const { readFileSync } = await import('node:fs');
  assert.doesNotMatch(readFileSync(new URL('../ide/vscode/src/chat-view.js', import.meta.url), 'utf8'), /module\.exports = \{[^}]*chatHtml/);
  assert.equal('BASE_ARGS' in require('../ide/vscode/src/chat-process.js'), false);
});
