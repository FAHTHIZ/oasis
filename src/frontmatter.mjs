// YAML front matter for skills, agents, commands, output styles, rules and memories,
// parsed with `yaml` (eemeli/yaml, YAML 1.2 core schema).
//
// Real-world front matter is often not valid YAML: `description: Use when: the user asks`
// has a second `: `. Claude Code and the Agent Skills tools accept that, so when strict
// parsing fails the top-level `key: plain value` lines are quoted and parsing is retried.
import { parse as parseYaml } from 'yaml';

const FENCE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
const YAML_OPTIONS = { uniqueKeys: false, maxAliasCount: 100, prettyErrors: false };

function strict(text, schema) {
  const value = parseYaml(text, { ...YAML_OPTIONS, schema });
  return value && typeof value === 'object' && !Array.isArray(value) ? value : value == null ? {} : null;
}

// Quotes top-level `key: value` lines whose value is not a block scalar, flow collection,
// quoted string or comment. Only used after strict parsing failed, so a leading `*`
// (`globs: **/*.ts`, an invalid alias) or `&`/`!` is treated as text too.
function quotePlainValues(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const match = /^([A-Za-z0-9_][\w.-]*)[ \t]*:[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!match || /^(["'[{#]|[|>][+-]?\d*$)/.test(match[2])) return line;
    return match[1] + ': ' + JSON.stringify(match[2]);
  }).join('\n');
}

/**
 * Parses a YAML mapping, leniently. Returns {} for empty or unreadable text.
 * schema 'core' gives typed scalars (config files); 'failsafe' keeps every scalar as
 * the string written (front matter, so `version: 1.0` stays '1.0').
 */
export function parseYamlMapping(text, { schema = 'core' } = {}) {
  const source = String(text || '');
  if (!source.trim()) return {};
  try { const value = strict(source, schema); if (value) return value; } catch {}
  try { return strict(quotePlainValues(source), schema) || {}; } catch { return {}; }
}

/**
 * Splits `---` front matter from a document.
 * Returns { metadata: raw YAML text or '', data: parsed mapping, body, hasFrontMatter }.
 */
export function splitFrontMatter(text) {
  const source = String(text == null ? '' : text);
  const match = FENCE.exec(source);
  if (!match) return { metadata: '', data: {}, body: source, hasFrontMatter: false };
  return { metadata: match[1], data: parseYamlMapping(match[1], { schema: 'failsafe' }), body: source.slice(match[0].length), hasFrontMatter: true };
}

function scalarText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(', ');
  if (typeof value === 'object') return '';
  return String(value).trim();
}

/** One front-matter value as text (keys match case-insensitively); '' when absent. */
export function frontMatterValue(metadata, key) {
  const data = typeof metadata === 'object' && metadata ? metadata : parseYamlMapping(metadata, { schema: 'failsafe' });
  const wanted = String(key).toLowerCase();
  const found = Object.keys(data).find((name) => name.toLowerCase() === wanted);
  return found === undefined ? '' : scalarText(data[found]);
}

/**
 * Front matter with lower-cased keys. Scalars are the trimmed strings written (`true`
 * reads as 'true'); lists and mappings are kept.
 */
export function parseFrontMatter(text) {
  const { data, body, hasFrontMatter } = splitFrontMatter(text);
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    out[key.toLowerCase()] = value == null ? '' : Array.isArray(value) ? value.map((item) => (item !== null && typeof item === 'object' ? item : scalarText(item))) : typeof value === 'object' ? value : String(value).trim();
  }
  return { data: out, body, hasFrontMatter };
}

/** Serialises a mapping as a front-matter block (`---\n...\n---\n`). */
export { stringify as stringifyYaml } from 'yaml';
