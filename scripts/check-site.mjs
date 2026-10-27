import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
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
  'id="view-agent"', 'id="agentForm"', 'id="agentTokenInput"', 'id="agentApprovalCard"', 'assistant_delta', 'id="agentStopBtn"', '/cancel',
  'id="view-extensions"', 'id="extensionInspectForm"', 'id="extensionScope"', 'id="extensionCandidateList"', 'id="extensionCompatibility"', 'Detected format:', 'id="installedExtensions"',
  'id="view-integrations"', 'data-integration-tab="connectors"', 'Specialist reviews', 'id="mcpAddForm"', '/api/extensions/inspect', '/api/extensions/install', '/api/mcp',
  'id="agentModelButton"', 'id="agentModelName"', '#view-agent.active{display:flex',
  'id="terminalForm"', 'id="terminalOutput"', '/api/terminal/command',
  'id="githubRepoSelect"', 'id="githubCloneBtn"', 'id="githubCheckBtn"', '/api/github/clone',
  'id="exportBtn"', 'id="importFile"', 'localStorage', 'id="providerSetupForm"', 'id="providerProtocol"', 'id="providerBaseUrl"', 'id="providerModel"', 'id="providerApiKey"',
  'function exportBackup()', 'function importBackup(file)',
  'prefers-reduced-motion', 'aria-live="polite"', 'rel="manifest"', "navigator.serviceWorker.register('./sw.js')",
  'rel="manifest"', "navigator.serviceWorker.register('./sw.js')"
];
for (const marker of required) {
  assert.ok(html.includes(marker), 'Missing required app feature/anchor: ' + marker);
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 1, 'Expected exactly one inline application script.');
assert.ok(scripts[0][1].trim().length > 0, 'Inline app script must not be empty.');
new Function(scripts[0][1]);
assert.ok(!/<script[^>]+src=/i.test(html), 'The starter should not depend on external scripts.');
assert.ok(!html.includes('window.prompt('), 'Core creation and management flows should use in-app dialogs, not browser prompts.');

const packageManifest = JSON.parse(packageText);
for (const requiredAsset of ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/']) {
  assert.ok(packageManifest.files.includes(requiredAsset), 'Installable CLI package must include ' + requiredAsset + ' for oasis web.');
}
const manifest = JSON.parse(manifestText);
assert.equal(manifest.name, 'Oasis OSS — Open Source Studio');
assert.equal(manifest.start_url, './');
assert.equal(manifest.display, 'standalone');
assert.ok(Array.isArray(manifest.icons) && manifest.icons.some((item) => item.src === './assets/oasis-icon.svg'));
assert.ok(icon.includes('<svg') && icon.includes('</svg>'), 'PWA icon must be a valid SVG document.');
assert.ok(serviceWorker.includes("self.addEventListener('install'"));
assert.ok(serviceWorker.includes("self.addEventListener('fetch'"));
assert.ok(serviceWorker.includes('event.respondWith'));
assert.ok(serviceWorker.includes("request.method !== 'GET'"), 'Service worker must not cache non-GET requests.');
assert.ok(serviceWorker.includes("url.pathname.startsWith('/api/')"), 'Service worker must never cache authenticated runtime API responses.');

console.log('Oasis integrity checks passed: app structure, inline JavaScript syntax, PWA manifest/icon, and offline service-worker safeguards.');
