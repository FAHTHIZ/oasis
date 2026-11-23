// Factory Droid's tool names, as the Claude Code tools OASIS shows: used for
// droid tool lists (plugins and .factory/droids) and hook matchers.

// Factory Droid tool IDs and categories -> Claude Code tool names.
const DROID_TOOLS = { Execute: ['Bash'], Create: ['Write'], ApplyPatch: ['Edit'], FetchUrl: ['WebFetch'], Read: ['Read'], LS: ['LS'], Grep: ['Grep'], Glob: ['Glob'], Edit: ['Edit'], MultiEdit: ['MultiEdit'], WebSearch: ['WebSearch'], TodoWrite: ['TodoWrite'], Task: ['Task'], Skill: ['Skill'] };
const DROID_CATEGORIES = { 'read-only': ['Read', 'Grep', 'Glob', 'LS'], edit: ['Edit', 'MultiEdit', 'Write'], execute: ['Bash'], web: ['WebFetch', 'WebSearch'] };

/** Claude Code tools for a droid's tools field (a category or a list of IDs), or null for all tools. */
export function droidToolNames(tools) {
  if (tools === undefined || tools === null || tools === '') return null;
  if (typeof tools === 'string' && DROID_CATEGORIES[tools.trim()]) return DROID_CATEGORIES[tools.trim()];
  const list = Array.isArray(tools) ? tools : String(tools).split(',');
  const names = [...new Set(list.map((t) => String(t).trim()).filter(Boolean).flatMap((t) => DROID_TOOLS[t] || DROID_CATEGORIES[t] || (/^[A-Za-z][A-Za-z0-9_]*$/.test(t) ? [t] : [])))];
  return names.length ? names : null;
}

// Droid tool names in a hook matcher, as the OASIS (Claude Code) tools they
// cover: Execute is Bash, Create is Write, ApplyPatch and Edit are the edit tools.
const DROID_MATCH = { Execute: ['Bash'], Create: ['Write'], ApplyPatch: ['Edit', 'MultiEdit', 'Write'], Edit: ['Edit', 'MultiEdit'], FetchUrl: ['WebFetch'] };
export function droidMatcher(matcher) {
  if (typeof matcher !== 'string' || !matcher) return matcher;
  if (!/\b(Execute|Create|ApplyPatch|Edit|FetchUrl)\b/.test(matcher)) return matcher;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return [...new Set(matcher.split(/[|,]/).map((item) => item.trim()).filter(Boolean).flatMap((item) => DROID_MATCH[item] || [item]))].join('|');
  return matcher.replace(/\b(Execute|Create|ApplyPatch|Edit|FetchUrl)\b/g, (name) => DROID_MATCH[name].length > 1 ? '(?:' + DROID_MATCH[name].join('|') + ')' : DROID_MATCH[name][0]);
}
