import fuzzysort from 'fuzzysort';

// Searchable actions for the browser workspace command panel.
// The panel is deliberately an index of real UI actions, not a second tool runtime.
export const APP_PALETTE_COMMANDS = Object.freeze([
  { id: 'new-chat', label: 'New chat', description: 'Start a fresh conversation', section: 'Workspace', keywords: 'conversation reset start over' },
  { id: 'open-chats', label: 'Open chats', description: 'Browse saved conversations in this project', section: 'Workspace', keywords: 'history sessions previous messages' },
  { id: 'export-chat', label: 'Download this chat', description: 'Save the conversation, with every tool step, as one HTML page', section: 'Workspace', keywords: 'export share save html transcript download' },
  { id: 'open-terminal', label: 'Open terminal', description: 'An interactive shell on the computer running OASIS, beside the chat', section: 'Workspace', keywords: 'shell console bash pty command line', runtimeOnly: true },
  { id: 'open-activity', label: 'Open activity', description: 'The run timeline: every step, how long it took and what failed', section: 'Workspace', keywords: 'trace timeline tool calls steps log waterfall history', shortcut: 'MOD+Shift+A' },
  { id: 'open-files', label: 'Open files', description: 'Browse project files and review changes', section: 'Workspace', keywords: 'workspace source code editor diff changes' },
  { id: 'open-plugins', label: 'Browse plugins and skills', description: 'Discover the integrations and specialist skills available to OASIS', section: 'Integrations', keywords: 'mcp tools extensions connectors plugins skills' },
  { id: 'connect-app', label: 'Connect an app', description: 'GitHub, Linear, Notion, Sentry, Jira and more, in one click', section: 'Integrations', keywords: 'connect connector oauth sign in login github linear notion jira slack apps mcp', runtimeOnly: true },
  { id: 'open-settings', label: 'Open settings', description: 'Manage model providers, approvals and workspace behaviour', section: 'Workspace', keywords: 'configuration preferences model provider api key' },
  { id: 'approval-mode', label: 'Change approval mode', description: 'Choose Ask first, Auto edit or Full auto', section: 'Workspace', keywords: 'permissions safety approval autonomy' },
  { id: 'sign-out', label: 'Sign out of this browser', description: 'Forget the access key here; open the OASIS link again to come back', section: 'Workspace', keywords: 'logout log out forget device access key lock', runtimeOnly: true },
  { id: 'focus-composer', label: 'Focus message box', description: 'Return to the message composer', section: 'Navigation', keywords: 'prompt input chat type message' },
  { id: 'keyboard-help', label: 'Keyboard shortcuts and help', description: 'See every supported keyboard shortcut', section: 'Help', keywords: 'help keys keyboard shortcuts guide', shortcut: 'MOD+/' }
]);

export const APP_KEYBOARD_SHORTCUTS = Object.freeze([
  { keys: 'MOD+K', label: 'Open the command palette', detail: 'Search workspace actions, chats, plugins and skills.' },
  { keys: '/', label: 'Open the command palette from the message box', detail: 'Type / when the message box is empty. Connected to OASIS on a computer, / suggests commands and skills instead; Ctrl+K opens the palette.' },
  { keys: '@', label: 'Mention a project file', detail: 'Type @ and part of a name; Tab or Enter inserts the path.' },
  { keys: 'Ctrl+`', label: 'Open or hide the terminal', detail: 'Connected to OASIS on a computer.' },
  { keys: 'MOD+Shift+A', label: 'Open or hide the activity timeline', detail: 'Every step of the run, with timings and failures.' },
  { keys: 'MOD+B', label: 'Show or hide the task sidebar', detail: 'On wide screens.' },
  { keys: 'MOD+/', label: 'Open keyboard shortcuts and help', detail: 'Works anywhere in the browser workspace.' },
  { keys: '?', label: 'Open keyboard shortcuts', detail: 'When you are not typing in a box or the terminal.' },
  { keys: 'Enter', label: 'Send your message', detail: 'On a desktop keyboard. On touch devices, use the Send button.' },
  { keys: 'Shift+Enter', label: 'Add a new line', detail: 'Keep writing without sending the message.' },
  { keys: 'Escape', label: 'Close the top dialog or menu', detail: 'The current task keeps running.' },
  { keys: '↑ / ↓', label: 'Move through command results', detail: 'Available while the command palette is open.' },
  { keys: 'Enter', label: 'Run the selected command', detail: 'Available while the command palette is open.' },
  { keys: 'Shift+Tab', label: 'Switch permission mode', detail: 'Cycles Ask first, Auto edit, Full auto and (on a computer) Plan.' },
  { keys: 'Tab', label: 'Accept a / or @ suggestion', detail: 'Arrow keys move through suggestions; Escape closes them.' }
]);

// Matching is fuzzysort (MIT, no dependencies): Sublime-style scores that reward
// contiguous runs and word starts, space-separated terms that may match
// different fields, typo-tolerant subsequences. A result has to score at least
// 70% of the best one, so "new chat" does not also list every other "chat".
const KEYS = ['label', 'keywords', 'description', 'section', 'shortcut'];
const MIN_SCORE = 0.2;

export function searchAppCommands(query, commands = APP_PALETTE_COMMANDS) {
  const search = String(query || '').trim();
  if (!search) return [...commands];
  const hits = fuzzysort.go(search, commands, { keys: KEYS, threshold: MIN_SCORE, limit: 0 });
  const best = hits.length ? hits[0].score : 0;
  return hits.filter((hit) => hit.score >= best * 0.7)
    .map((hit) => ({ item: hit.obj, score: hit.score, index: commands.indexOf(hit.obj) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
