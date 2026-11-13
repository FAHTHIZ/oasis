// Built-in plugins for the universal app. A plugin bundles skills (expert
// instructions the agent follows), a few one-tap starter tasks, and words that
// tell the app when to suggest it. Turning a plugin on preloads its skills
// into the agent's prompt; suggestions appear above the message box as the
// user types, so the right plugin is one tap away. No network, no DOM.

export const PLUGINS = [
  {
    id: 'debug', name: 'Debugger', icon: 'bug', skills: ['debugging', 'diagnose'],
    description: 'Finds the root cause of a bug, fixes it, and proves the fix with a test.',
    keywords: ['bug', 'error', 'fix', 'crash', 'broken', 'fails', 'failing', 'exception', 'stack trace', 'traceback', 'not working', "doesn't work", 'does not work', 'undefined', 'null', 'wrong output', 'regression'],
    starters: ['Find and fix the bug that makes the tests fail', 'Explain this error and fix it:']
  },
  {
    id: 'tests', name: 'Test writer', icon: 'check', skills: ['testing', 'verify'],
    description: 'Writes focused tests, runs them in the sandbox, and reports coverage gaps.',
    keywords: ['test', 'tests', 'unit test', 'coverage', 'assert', 'spec', 'jest', 'vitest', 'mocha', 'verify', 'tdd'],
    starters: ['Write tests for the main module and run them', 'Find untested code paths and cover them']
  },
  {
    id: 'review', name: 'Code reviewer', icon: 'eye', skills: ['code-review'],
    description: 'Reviews changes like a senior engineer: correctness, edge cases, readability.',
    keywords: ['review', 'code review', 'pr', 'pull request', 'diff', 'quality', 'refactor', 'clean up', 'cleanup', 'smell', 'check my code'],
    starters: ['Review my changes and list concrete problems', 'Review the whole project and suggest the top 5 fixes']
  },
  {
    id: 'security', name: 'Security audit', icon: 'shield-check', skills: ['security-review'],
    description: 'Hunts for secrets, injection, unsafe input handling and auth mistakes.',
    keywords: ['security', 'secure', 'vulnerab', 'secret', 'password', 'token', 'xss', 'injection', 'csrf', 'auth', 'exploit', 'cve', 'sanitize'],
    starters: ['Audit this project for security problems', 'Check for leaked secrets and unsafe input handling']
  },
  {
    id: 'web', name: 'Web app studio', icon: 'globe', skills: ['web-app-development'], 
    description: 'Builds polished, responsive websites and web apps that work without a build step.',
    keywords: ['website', 'web app', 'webapp', 'html', 'css', 'landing page', 'page', 'ui', 'frontend', 'react', 'vue', 'svelte', 'tailwind', 'game', 'dashboard', 'todo app', 'portfolio'],
    starters: ['Build a polished landing page for my product in index.html', 'Make a todo app in one HTML file with local storage', 'Make a small browser game']
  },
  {
    id: 'api', name: 'API builder', icon: 'plug', skills: ['api-development'],
    description: 'Designs and builds REST and JSON APIs with validation and tests.',
    keywords: ['api', 'endpoint', 'rest', 'route', 'server', 'express', 'fastapi', 'flask', 'graphql', 'webhook', 'json'],
    starters: ['Design a REST API for this project and implement it', 'Add input validation to every endpoint']
  },
  {
    id: 'mobile', name: 'Mobile apps', icon: 'smartphone', skills: ['mobile-development'],
    description: 'React Native, Flutter, Swift and Kotlin know-how for phone apps.',
    keywords: ['android', 'ios', 'mobile', 'react native', 'flutter', 'swift', 'kotlin', 'expo', 'iphone', 'phone app'],
    starters: ['Explain how this mobile app is structured', 'Add a settings screen to the app']
  },
  {
    id: 'docs', name: 'Docs writer', icon: 'book-open', skills: ['init'],
    prompt: 'When writing documentation, be accurate to the code: read it first, keep examples runnable, and prefer short sections with headings.',
    description: 'Writes and updates READMEs, guides and code comments that match the code.',
    keywords: ['readme', 'docs', 'documentation', 'document', 'comment', 'changelog', 'guide', 'tutorial', 'jsdoc', 'docstring'],
    starters: ['Write a clear README for this project', 'Update the docs to match the code']
  },
  {
    id: 'github', name: 'GitHub', icon: 'git-branch', skills: [], actions: ['github'],
    prompt: 'When the work is done and the user asks to share it, use github_push to commit to a new branch and open a pull request.',
    description: 'Opens any GitHub repository and pushes your changes back as a pull request.',
    keywords: ['github', 'repo', 'repository', 'clone', 'pull request', 'push', 'commit', 'branch'],
    starters: ['Commit my changes to a new branch and open a pull request']
  }
];

const BY_ID = new Map(PLUGINS.map((plugin) => [plugin.id, plugin]));

export function getPlugin(id) {
  return BY_ID.get(id) || null;
}

/** The plugins for a list of ids, in catalog order, unknown ids dropped. */
export function pluginsFor(ids = []) {
  const wanted = new Set(ids);
  return PLUGINS.filter((plugin) => wanted.has(plugin.id));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MATCHERS = PLUGINS.map((plugin) => ({
  plugin,
  patterns: plugin.keywords.map((word) => ({ word, weight: word.includes(' ') ? 2 : 1, re: new RegExp('(^|[^a-z])' + escapeRegExp(word) + (word.endsWith('ab') ? '' : '(?:s|es|ed|ing|d)?(?![a-z])'), 'i') }))
}));

/**
 * Plugins that fit what the user is typing, best first. Cheap enough to run
 * on every keystroke on a slow phone (a dozen short regexes).
 */
export function suggestPlugins(text, { active = [], limit = 2 } = {}) {
  const input = String(text || '').slice(0, 600);
  if (input.trim().length < 3) return [];
  const on = new Set(active);
  const scored = [];
  for (const { plugin, patterns } of MATCHERS) {
    if (on.has(plugin.id)) continue;
    let score = 0;
    for (const pattern of patterns) if (pattern.re.test(input)) score += pattern.weight;
    if (score) scored.push({ plugin, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.plugin);
}
