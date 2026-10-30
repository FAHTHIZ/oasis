import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [html, manifestText, serviceWorker, icon, sidebarMark, interfaceCss, packageText] = await Promise.all([
  read('../index.html'),
  read('../manifest.webmanifest'),
  read('../sw.js'),
  read('../assets/oasis-icon.svg'),
  read('../assets/oasis-mark.svg'),
  read('../assets/oasis-interface.css'),
  read('../package.json')
]);
const required = [
  '<!doctype html>', 'id="view-home"', 'id="view-projects"',
  'id="view-tasks"', 'id="view-notes"', 'id="projectDialog"', 'id="taskDialog"', 'id="manageProjectDialog"', 'id="dashboardProjects"',
  'id="allProjects"', 'id="allTasks"', 'id="notesEditor"',
  'id="view-agent"', 'runtime-scope-note', 'src="./assets/oasis-mark.svg"', 'Local only by default:', 'It is not open to the public internet by default.', 'Remote access requires explicit server options', 'never share your runtime connection token.', 'id="agentForm"', 'id="agentTokenInput"', 'id="agentApprovalCard"', 'aria-live="assertive"', 'aria-labelledby="agentApprovalTitle"', 'OASIS needs your permission', '>Deny</button>', '>Allow once</button>', 'Always allow for this session', 'for this session', 'assistant_delta', 'id="agentStopBtn"', '/cancel',
  'id="view-monitor"', 'id="agentMonitorRefreshBtn"', 'id="agentMonitorOpenSessionBtn"', 'id="agentMonitorReviewRunBtn"', 'id="agentMonitorStats"', 'id="agentMonitorRunList"', 'id="agentMonitorWorkers"', 'id="agentMonitorEvents"', 'function agentLoadMonitor(', "agentApi('/api/agent-monitor')", 'agentOpenCloudRun(id,title)', 'canReviewIsolatedDiff',
  'id="view-extensions"', 'id="extensionInspectForm"', 'id="extensionScope"', 'id="extensionCandidateList"', 'id="extensionCompatibility"', 'Detected format:', 'id="installedExtensions"',
  'id="view-integrations"', 'data-integration-tab="connectors"', 'Specialist reviews', 'id="mcpAddForm"', '/api/extensions/inspect', '/api/extensions/install', '/api/mcp',
  'id="agentModelButton"', 'id="agentModelName"', '#view-agent.active{display:flex',
  'id="terminalForm"', 'id="terminalOutput"', '/api/terminal/command',
  'id="githubRepoSelect"', 'id="githubCloneBtn"', 'id="githubCheckBtn"', '/api/github/clone',
  'id="exportBtn"', 'id="importFile"', 'localStorage', 'id="providerSetupForm"', 'id="providerProtocol"', 'id="providerBaseUrl"', 'id="providerModel"', 'id="providerApiKey"',
  'id="firstRunWizard"', 'data-first-run="api"', 'data-first-run="omniroute"', 'data-first-run="ollama"', 'aria-pressed="false"',
  'id="firstRunStatus"', 'id="firstRunOllamaLink"', 'id="providerKeyHelp"', '@media(max-width:390px)',
  'id="agentWorkspaceGrid"', 'id="agentChatTab"', 'id="agentTerminalTab"', 'id="agentTerminalToggle"', 'id="agentSplitDivider"',
  'id="agentTerminalUtilityTab"', 'id="agentRunsUtilityTab"', 'id="agentTerminalUtilityPanel"',
  'id="agentRunsUtilityPanel"', 'aria-label="Workspace utilities"', 'Runs &amp; changes',

  'class="intro-row agent-page-heading"', 'class="agent-page-context"', 'class="agent-setup-heading"',
  'class="agent-chat-identity"', 'class="agent-compose-form"', 'aria-label="Runtime connection"',

  'aria-label="Resize chat and terminal panels"', 'oasis.agent.chatSplit', 'ArrowLeft', 'ArrowRight',
  'id="agentEmptyState"', 'data-agent-example="Explain this project"', 'data-agent-example="Find a bug"', 'data-agent-example="Write tests"',
  'id="commandPaletteDialog"', 'id="commandPaletteSearch"', 'id="commandPaletteButton"', 'commandPaletteOpen()', 'starter-find-bug', 'Ctrl+K or ?',
  "document.getElementById('agentStopBtn').disabled=!agentBusy",
  'function exportBackup()', 'function importBackup(file)',
  'prefers-reduced-motion', 'aria-live="polite"', 'rel="manifest"', "navigator.serviceWorker.register('./sw.js')"
];
assert.ok(html.includes('href="./assets/oasis-interface.css"'), 'The app must load its local visual-system stylesheet.');
function cssColorToken(name) {
  const match = interfaceCss.match(new RegExp('--' + name + ':\s*(#[0-9A-F]{6})', 'i'));
  assert.ok(match, 'Missing six-digit color token: --' + name);
  return match[1].toUpperCase();
}
function relativeLuminance(hex) {
  const values = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = values.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
const palette = Object.fromEntries([
  'bg', 'sidebar', 'panel', 'line', 'line-strong', 'text', 'muted',
  'accent', 'accent-ink', 'danger', 'diff-add', 'diff-remove'
].map((name) => [name, cssColorToken(name)]));
assert.equal(palette.bg, '#0B100C');
assert.equal(palette.sidebar, '#0D130E');
assert.equal(palette.panel, '#101811');
assert.equal(palette.line, '#1C271F');
assert.equal(palette['line-strong'], '#2B3B30');
assert.equal(palette.text, '#E8EFE9');
assert.equal(palette.muted, '#9BAA9F', 'Muted text must be at least as bright as the brief requires.');
assert.equal(palette.accent, '#9BFF55');
assert.equal(palette['accent-ink'], '#0B100C');
assert.equal(palette.danger, '#FF8A8A');
assert.equal(palette['diff-add'], '#9BFF55');
assert.equal(palette['diff-remove'], '#FF8A8A');
for (const surface of ['bg', 'sidebar', 'panel', 'line-strong']) {
  assert.ok(contrastRatio(palette.text, palette[surface]) >= 4.5, 'Primary text contrast must be at least 4.5:1 on --' + surface);
  assert.ok(contrastRatio(palette.muted, palette[surface]) >= 4.5, 'Muted text contrast must be at least 4.5:1 on --' + surface);
}
assert.ok(contrastRatio(palette['accent-ink'], palette.accent) >= 4.5, 'Text on the lime action color must meet 4.5:1.');
assert.ok(contrastRatio(palette.danger, palette.panel) >= 4.5, 'Risk text must meet 4.5:1 on a panel.');
assert.match(interfaceCss, /--font-body:Inter/);
assert.match(interfaceCss, /--font-code:"JetBrains Mono"/);
assert.match(interfaceCss, /\.hero:after\{display:none\}/, 'Decorative hero rings must stay out of the primary workspace.');
assert.match(interfaceCss, /\.btn-primary\{background:var\(--surface-muted\)/, 'Generic primary buttons must remain neutral.');
assert.match(interfaceCss, /#agentSendBtn,#newAgentSessionBtn,#agentApproveBtn,#agentAlwaysBtn\s*\{/);
assert.ok(interfaceCss.includes('Chat-first coding workspace:'), 'The chat-first layout must remain a separately maintained local stylesheet.');
assert.match(interfaceCss, /grid-template-areas:\s*"prompt prompt"\s*"context actions"/, 'Desktop composer must keep its prompt above the action footer.');
assert.match(interfaceCss, /grid-template-areas:\s*"prompt"\s*"context"\s*"actions"/, 'Phone composer must stack the prompt, context and actions.');
assert.ok(interfaceCss.includes('grid-template-columns:minmax(0,var(--agent-chat-split)) 10px minmax(300px,1fr)'), 'Desktop workspace must preserve a resizable chat/terminal split.');
assert.ok(interfaceCss.includes('@media(max-width:780px)'), 'Phone workspace tabs must have a dedicated responsive layout.');
assert.ok(interfaceCss.includes('@media(max-width:390px)'), 'The narrow 390px phone layout must be covered.');
assert.ok(html.includes("option.setAttribute('aria-pressed',String(option===button))"), 'First-run route selection must update its accessible pressed state.');
assert.ok(interfaceCss.includes('.first-run-choice[aria-pressed="true"]'), 'Selected first-run route must be visually apparent.');
assert.ok(interfaceCss.includes('.first-run-status[data-error="true"]'), 'Local-model discovery errors must have an explicit status treatment.');

assert.ok(interfaceCss.includes('/* Utility rail: keep terminal and coding-run diffs next to the conversation. */'), 'Terminal and recent coding runs must share a utility rail.');
assert.ok(interfaceCss.includes('.agent-utility-tab[aria-selected="true"]'), 'Utility tabs must expose a selected state.');
assert.ok(html.includes("event.key!=='ArrowLeft'&&event.key!=='ArrowRight'"), 'Utility tabs must support left/right keyboard navigation.');
assert.ok(html.includes("terminalTab.tabIndex=selected==='terminal'?0:-1"), 'Only the selected utility tab should remain in the tab sequence.');
assert.ok(html.includes("Hide side panel"), 'The utility visibility control must name the whole side panel.');
assert.ok(html.includes("window.oasisAgentSetUtilityPanel('terminal')"), 'The terminal command-palette action must explicitly select Terminal.');
assert.ok(html.includes("workspaceGrid.dataset.terminalVisible==='false'&&utilityToggle"), 'Run-monitor diff review must restore a hidden utility rail before selecting Runs & changes.');



assert.ok(interfaceCss.includes('.agent-utility-view[hidden]{display:none!important}'), 'Inactive utility panels must remain hidden.');
assert.ok(interfaceCss.includes('#view-agent.active .agent-workspace-grid .agent-utility-view .cloud-runs-panel'), 'The existing run history and diff viewer must render inside the utility panel.');


assert.match(interfaceCss, /\.agent-message\{font-size:14px\}/);
assert.match(interfaceCss, /\.agent-message\.activity\{font-size:12\.5px/);
const limeConsumers = [...interfaceCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => /var\(--accent\)/.test(match[2]));
assert.equal(limeConsumers.length, 1, 'Lime must be reserved for Send, New chat, and approval actions.');
assert.match(limeConsumers[0][1], /#agentSendBtn.*#newAgentSessionBtn.*#agentApproveBtn.*#agentAlwaysBtn/);
assert.ok(serviceWorker.includes("'./assets/oasis-interface.css'"), 'The visual-system stylesheet must be available offline.');
for (const marker of required) {
  assert.ok(html.includes(marker), 'Missing required app feature/anchor: ' + marker);
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
const qualityWorkflow = await read('../.github/workflows/quality.yml');
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
assert.ok(e2e.includes("import AxeBuilder from '@axe-core/playwright'"), 'Browser E2E must use axe-core for accessibility scans.');
assert.ok(e2e.includes("new AxeBuilder({ page })"), 'Browser E2E must run axe against the real browser page.');
assert.ok(e2e.includes(".include('#view-agent')"), 'Axe scans must target the Agent workspace.');
assert.ok(e2e.includes("violation.id === 'color-contrast'"), 'Agent view contrast violations must fail browser E2E.');
assert.ok(e2e.includes("First-run setup · 390px"), 'Axe must scan the first-run screen at phone width.');
assert.ok(qualityWorkflow.includes('@axe-core/playwright@4.14.0'), 'The CI-only axe package must use the documented exact version.');

assert.ok(e2e.includes('#agentMonitorReviewRunBtn'), 'Browser E2E must exercise the worktree review action from Run Monitor.');

const manifest = JSON.parse(manifestText);
assert.equal(manifest.name, 'OASIS — Coding Agent Workspace');
assert.equal(manifest.short_name, 'OASIS');
assert.equal(manifest.start_url, './');
assert.equal(manifest.display, 'standalone');
assert.ok(Array.isArray(manifest.icons) && manifest.icons.some((item) => item.src === './assets/oasis-icon.svg'));
assert.ok(icon.includes('<svg') && icon.includes('</svg>'), 'PWA icon must be a valid SVG document.');
assert.ok(sidebarMark.startsWith('<svg') && sidebarMark.includes('<path d='), 'Sidebar brand mark must be a populated SVG document.');
assert.ok(html.includes('src="./assets/oasis-mark.svg"'), 'Sidebar must reference the OASIS portal mark.');
assert.ok(!html.includes('id="view-agent">\\n<div'), 'Agent view must not contain a literal escaped newline before its runtime note.');
assert.ok(serviceWorker.includes("self.addEventListener('install'"));
assert.ok(serviceWorker.includes("self.addEventListener('fetch'"));
assert.ok(serviceWorker.includes('event.respondWith'));
assert.ok(serviceWorker.includes("request.method !== 'GET'"), 'Service worker must not cache non-GET requests.');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"), 'Service worker must never cache authenticated runtime API responses.');

console.log('OASIS integrity checks passed: app structure, inline JavaScript syntax, PWA manifest/icon, and offline service-worker safeguards.');
