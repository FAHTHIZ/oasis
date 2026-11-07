// Searchable actions for the browser workspace command panel.
// The panel is deliberately an index of real UI actions, not a second tool runtime.
export const APP_PALETTE_COMMANDS = Object.freeze([
  { id: 'new-chat', label: 'New chat', description: 'Start a fresh conversation', section: 'Workspace', keywords: 'conversation reset start over' },
  { id: 'open-chats', label: 'Open chats', description: 'Browse saved conversations in this project', section: 'Workspace', keywords: 'history sessions previous messages' },
  { id: 'open-files', label: 'Open files', description: 'Browse project files and review changes', section: 'Workspace', keywords: 'workspace source code editor diff changes' },
  { id: 'open-plugins', label: 'Browse plugins and skills', description: 'Discover the integrations and specialist skills available to OASIS', section: 'Integrations', keywords: 'mcp tools extensions connectors plugins skills' },
  { id: 'open-settings', label: 'Open settings', description: 'Manage model providers, approvals and workspace behaviour', section: 'Workspace', keywords: 'configuration preferences model provider api key' },
  { id: 'approval-mode', label: 'Change approval mode', description: 'Choose Ask first, Auto edit or Full auto', section: 'Workspace', keywords: 'permissions safety approval autonomy' },
  { id: 'focus-composer', label: 'Focus message box', description: 'Return to the message composer', section: 'Navigation', keywords: 'prompt input chat type message' },
  { id: 'keyboard-help', label: 'Keyboard shortcuts and help', description: 'See every supported keyboard shortcut', section: 'Help', keywords: 'help keys keyboard shortcuts guide', shortcut: 'MOD+/' }
]);

export const APP_KEYBOARD_SHORTCUTS = Object.freeze([
  { keys: 'MOD+K', label: 'Open the command palette', detail: 'Search workspace actions, chats, plugins and skills.' },
  { keys: '/', label: 'Open the command palette from the message box', detail: 'Type / when the message box is empty.' },
  { keys: 'MOD+/', label: 'Open keyboard shortcuts and help', detail: 'Works anywhere in the browser workspace.' },
  { keys: 'Enter', label: 'Send your message', detail: 'On a desktop keyboard. On touch devices, use the Send button.' },
  { keys: 'Shift+Enter', label: 'Add a new line', detail: 'Keep writing without sending the message.' },
  { keys: 'Escape', label: 'Close the top dialog or menu', detail: 'The current task keeps running.' },
  { keys: '↑ / ↓', label: 'Move through command results', detail: 'Available while the command palette is open.' },
  { keys: 'Enter', label: 'Run the selected command', detail: 'Available while the command palette is open.' }
]);

function termScore(haystack, term) {
  const exact = haystack.indexOf(term);
  if (exact >= 0) return exact + (exact === 0 ? 0 : 5);
  let cursor = 0;
  let gaps = 0;
  for (const character of term) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return Infinity;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 35 + gaps;
}

export function searchAppCommands(query, commands = APP_PALETTE_COMMANDS) {
  const terms = String(query || '').trim().toLowerCase().split(/[ \t\r\n]+/).filter(Boolean);
  return commands.map((item, index) => {
    const haystack = [item.label, item.description, item.section, item.keywords, item.shortcut].filter(Boolean).join(' ').toLowerCase();
    const scores = terms.map((term) => termScore(haystack, term));
    return { item, index, score: scores.some((score) => !Number.isFinite(score)) ? Infinity : scores.reduce((sum, score) => sum + score, 0) };
  }).filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}
