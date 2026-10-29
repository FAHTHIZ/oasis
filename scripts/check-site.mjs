import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  assert.match(value, /^[0-9a-f]{6}$/i, 'Contrast check expects six-digit hex colors.');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
const [html, manifestText, serviceWorker, icon, packageText] = await Promise.all([
  read('../index.html'),
  read('../manifest.webmanifest'),
  read('../sw.js'),
  read('../assets/oasis-icon.svg'),
  read('../package.json')
]);
const required = [
  '<!doctype html>', 'id="view-home"', 'id="view-projects"',
  'id="view-tasks"', 'id="view-notes"', 'id="projectDialog"', 'id="taskDialog"', 'id="manageProjectDialog"', 'id="dashboardProjects"',
  'id="allProjects"', 'id="allTasks"', 'id="notesEditor"',
  'id="view-agent"', 'runtime-scope-note', 'Remote access requires explicit server options.', 'Never share your runtime connection token.', 'id="agentForm"', 'id="agentTokenInput"', 'id="agentApprovalCard"', 'assistant_delta', 'id="agentStopBtn"', '/cancel',
  'id="view-monitor"', 'id="agentMonitorRefreshBtn"', 'id="agentMonitorOpenSessionBtn"', 'id="agentMonitorReviewRunBtn"', 'id="agentMonitorStats"', 'id="agentMonitorRunList"', 'id="agentMonitorWorkers"', 'id="agentMonitorEvents"', 'function agentLoadMonitor(', "agentApi('/api/agent-monitor')", 'agentOpenCloudRun(id,title)', 'canReviewIsolatedDiff',
  'id="view-extensions"', 'id="extensionInspectForm"', 'id="extensionScope"', 'id="extensionCandidateList"', 'id="extensionCompatibility"', 'Detected format:', 'id="installedExtensions"',
  'id="view-integrations"', 'data-integration-tab="connectors"', 'Specialist reviews', 'id="mcpAddForm"', '/api/extensions/inspect', '/api/extensions/install', '/api/mcp',
  'id="agentModelButton"', 'id="agentModelName"', '#view-agent.active{display:flex',
  'id="terminalForm"', 'id="terminalOutput"', '/api/terminal/command',
  'id="githubRepoSelect"', 'id="githubCloneBtn"', 'id="githubCheckBtn"', '/api/github/clone',
  'id="exportBtn"', 'id="importFile"', 'localStorage', 'id="providerSetupForm"', 'id="providerProtocol"', 'id="providerBaseUrl"', 'id="providerModel"', 'id="providerApiKey"',
  'id="firstRunWizard"', 'data-first-run="api"', 'data-first-run="omniroute"', 'data-first-run="ollama"',
  'id="firstRunStatus"', 'id="firstRunOllamaLink"', 'id="providerKeyHelp"', '@media(max-width:390px)',
  'id="agentWorkspaceGrid"', 'id="agentChatTab"', 'id="agentTerminalTab"', 'id="agentTerminalToggle"', 'id="agentSplitDivider"',
  'aria-label="Resize chat and terminal panels"', 'oasis.agent.chatSplit', 'ArrowLeft', 'ArrowRight',
  'id="agentEmptyState"', 'data-agent-example="Explain this project"', 'data-agent-example="Find a bug"', 'data-agent-example="Write tests"',
  'id="commandPaletteDialog"', 'id="commandPaletteSearch"', 'id="commandPaletteButton"', 'commandPaletteOpen()', 'starter-find-bug', 'Ctrl+K or ?',
  "document.getElementById('agentStopBtn').disabled=!agentBusy",
  'function exportBackup()', 'function importBackup(file)',
  'prefers-reduced-motion', 'aria-live="polite"', 'rel="manifest"', "navigator.serviceWorker.register('./sw.js')",
  'color:#84968a', 'color:#87988b'
];
for (const marker of required) {
  assert.ok(html.includes(marker), 'Missing required app feature/anchor: ' + marker);
}

for (const [label, foreground, background] of [
  ['section labels', '#84968a', '#0d1713'],
  ['sidebar footer', '#87988b', '#0b0f0c'],
  ['muted body text', '#9aa99d', '#0b0f0c']
]) {
  assert.ok(contrastRatio(foreground, background) >= 4.5, label + ' must meet WCAG AA contrast for normal text.');
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 1, 'Expected exactly one inline application script.');
assert.ok(scripts[0][1].trim().length > 0, 'Inline app script must not be empty.');
new Function(scripts[0][1]);
assert.ok(!/<script[^>]+src=[\"']https?:/i.test(html), 'The starter must not load third-party scripts.');
for (const asset of ['/assets/vendor/xterm.js', '/assets/vendor/xterm-addon-fit.js']) assert.ok(html.includes(asset), 'Missing local terminal renderer asset reference: ' + asset);
assert.ok(!html.includes('window.prompt('), 'Core creation and management flows should use in-app dialogs, not browser prompts.');

const packageManifest = JSON.parse(packageText);
for (const requiredAsset of ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/']) {
  assert.ok(packageManifest.files.includes(requiredAsset), 'Installable CLI package must include ' + requiredAsset + ' for oasis web.');
}
const desktopMain = await read('../desktop/main.mjs');
const webRuntime = await read('../src/web.mjs');
const secureSecrets = await read('../desktop/secure-secrets.mjs');
const e2e = await read('../.github/scripts/browser-e2e.mjs');
assert.ok(desktopMain.includes('onProviderConfig: persistDesktopProviderConfig'), 'Desktop provider setup must use encrypted key storage.');
assert.ok(desktopMain.includes('const previousSecret = await loadDesktopApiKey'), 'Desktop provider saves must capture the prior secret for rollback.');
assert.ok(desktopMain.includes("await saveDesktopApiKey(previousSecret || ''"), 'Desktop provider saves must restore the prior secret if config persistence fails.');
assert.ok(secureSecrets.includes('safeStorage.encryptString'), 'Desktop secret storage must encrypt API keys.');
assert.ok(webRuntime.includes("pathname === '/api/provider/local-models'"), 'The first-run wizard needs local model discovery.');
assert.ok(webRuntime.includes("http://127.0.0.1:11434/api/tags"), 'Ollama discovery must use a fixed local endpoint.');
assert.ok(webRuntime.includes("if (!isLoopbackClient(req))"), 'Local model discovery must be limited to loopback clients.');
assert.ok(webRuntime.includes('text = redactApprovalSecrets(text)'), 'Browser tool-result summaries must redact credential values.');
assert.ok(e2e.includes('Denying the delete approval must leave the file intact.'), 'Browser E2E must verify destructive actions can be denied.');
assert.ok(e2e.includes('Cancellation must abort the task before another model request.'), 'Browser E2E must verify cancellation interrupts a pending task.');
assert.ok(e2e.includes("page.keyboard.press('Control+k')"), 'Browser E2E must exercise the browser command palette.');
assert.ok(e2e.includes('Selecting a starter must not send a message.'), 'Browser palette selection must not automatically send an agent task.');
assert.ok(e2e.includes('Saved-chat recovery must reopen the parent chat without restarting workers.'), 'Browser E2E must verify saved-chat recovery does not imply worker resurrection.');
assert.ok(e2e.includes('#agentMonitorOpenSessionBtn'), 'Browser E2E must exercise the run monitor saved-chat control.');
assert.ok(e2e.includes('PASS isolated-diff review:'), 'Browser E2E must verify the run monitor can open the isolated worktree diff.');
assert.ok(e2e.includes('#agentMonitorReviewRunBtn'), 'Browser E2E must exercise the worktree review action from Run Monitor.');

const manifest = JSON.parse(manifestText);
assert.equal(manifest.name, 'OASIS — Coding Agent Workspace');
assert.equal(manifest.short_name, 'OASIS');
assert.equal(manifest.start_url, './');
assert.equal(manifest.display, 'standalone');
assert.ok(Array.isArray(manifest.icons) && manifest.icons.some((item) => item.src === './assets/oasis-icon.svg'));
assert.ok(icon.includes('<svg') && icon.includes('</svg>'), 'PWA icon must be a valid SVG document.');
assert.ok(serviceWorker.includes("self.addEventListener('install'"));
assert.ok(serviceWorker.includes("self.addEventListener('fetch'"));
assert.ok(serviceWorker.includes('event.respondWith'));
assert.ok(serviceWorker.includes("request.method !== 'GET'"), 'Service worker must not cache non-GET requests.');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"), 'Service worker must never cache authenticated runtime API responses.');

console.log('OASIS integrity checks passed: app structure, inline JavaScript syntax, PWA manifest/icon, and offline service-worker safeguards.');
