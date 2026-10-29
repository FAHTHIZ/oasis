// Output styles (Claude Code compatible): change how Oasis explains its work.
// Built-ins: default, concise, explanatory, architect, reviewer, and legacy learning. Custom styles are Markdown files in
// .oasis/output-styles, .claude/output-styles, or the user-level equivalents.
// Enabled Claude Code plugins add theirs as plugin-name:style.
import { readdir, readFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { parseFrontMatter } from './subagents.mjs';

const MAX_STYLE_FILE = 32 * 1024;

export const BUILTIN_STYLES = {
  default: { name: 'default', description: 'Concise software-engineering answers (standard behavior)', source: 'built-in', prompt: '' },
  concise: {
    name: 'concise', description: 'Direct answers with minimal narration and compact checklists', source: 'built-in',
    prompt: [
      'Output style: concise. Lead with the result, use short sentences, and omit background the user does not need.',
      'Prefer compact bullets for actions and verification. Preserve important risks, blockers, caveats, and exact test evidence.',
      'Never omit required safety checks or claim work/tests that were not done. Follow all project rules and user constraints.'
    ].join('\n')
  },
  explanatory: {
    name: 'explanatory', description: 'Explains implementation choices and codebase patterns while working', source: 'built-in',
    prompt: [
      'Output style: explanatory. While completing the task, help the user understand the codebase and your choices.',
      'Before and after meaningful code changes, add short "Insight" notes (2-3 bullet points) about why this approach fits this codebase, patterns you noticed, and trade-offs.',
      'Keep insights specific to this code, not general programming advice. Still finish the task completely.'
    ].join('\n')
  },
  architect: {
    name: 'architect', description: 'Focuses on system boundaries, trade-offs, dependencies, and migration safety', source: 'built-in',
    prompt: [
      'Output style: architect. Structure substantial work as: goal and constraints; existing architecture; proposed design; boundaries and data flow; trade-offs and risks; implementation sequence; verification.',
      'Favor simple modular designs, explicit contracts, local-first defaults, backwards compatibility, and reversible migrations.',
      'Do not turn every small question into a design document. Obey project instructions, permissions, and user constraints.'
    ].join('\n')
  },
  reviewer: {
    name: 'reviewer', description: 'Evidence-first review emphasizing defects, regressions, and actionable findings', source: 'built-in',
    prompt: [
      'Output style: reviewer. Evidence-first review: prioritize concrete findings by severity. For each finding provide location, evidence, impact, and a narrowly scoped fix.',
      'Separate confirmed defects from hypotheses and missing verification. Do not invent findings or present style preferences as bugs.',
      'When reviewing code, inspect changed code and relevant callers/tests. State what was tested and what was not. Preserve all project rules.'
    ].join('\n')
  },
  learning: {
    name: 'learning', description: 'Collaborative learn-by-doing mode: asks you to write small pieces yourself', source: 'built-in',
    prompt: [
      'Output style: learning. Act as a collaborative teacher while still moving the task forward.',
      'Add short "Insight" notes explaining key decisions. For one or two small, meaningful pieces of logic (5-10 lines, such as a business rule or an error-handling choice), do not write them yourself:',
      'add a clearly marked TODO(human) in the code with context, then ask the user to implement it, explaining what it should do and the trade-offs. Write all the surrounding code yourself.',
      'Never leave the project broken except for the clearly marked TODO(human) pieces.'
    ].join('\n')
  }
};

export function outputStyleDirectories(root, env = process.env, home = os.homedir()) {
  return [
    { dir: path.join(home, '.claude', 'output-styles'), scope: 'user' },
    { dir: path.join(getConfigDirectory(env, home), 'output-styles'), scope: 'user' },
    ...(root ? [
      { dir: path.join(path.resolve(root), '.claude', 'output-styles'), scope: 'project' },
      { dir: path.join(path.resolve(root), '.oasis', 'output-styles'), scope: 'project' }
    ] : [])
  ];
}

export async function loadOutputStyles(root, options = {}) {
  const styles = { ...BUILTIN_STYLES };
  for (const { dir, scope } of outputStyleDirectories(root, options.env || process.env, options.home || os.homedir())) {
    let names = [];
    try { names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort(); } catch { continue; }
    for (const file of names) {
      const full = path.join(dir, file);
      try {
        const info = await lstat(full);
        if (!info.isFile() || info.size > MAX_STYLE_FILE) continue;
        const { data, body } = parseFrontMatter(await readFile(full, 'utf8'));
        const name = String(data.name || file.slice(0, -3)).trim().toLowerCase().replace(/\s+/g, '-');
        if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(name) || !body.trim()) continue;
        styles[name] = { name, description: String(data.description || body.trim().split('\n')[0]).slice(0, 200), source: scope, file: full, prompt: 'Output style: ' + name + '.\n' + body.trim() };
      } catch { /* Skip unreadable style files. */ }
    }
  }
  // Output styles shipped by enabled Claude Code plugins, named plugin:style.
  if (!options.skipPlugins) {
    try {
      const { loadEnabledPlugins, pluginOutputStyles } = await import('./claude-plugins.mjs');
      for (const style of await pluginOutputStyles(await loadEnabledPlugins(root, { env: options.env || process.env }))) {
        if (!styles[style.name]) styles[style.name] = style;
      }
    } catch { /* Plugins are optional. */ }
  }
  return styles;
}

const STYLE_BLOCK = /\n\n<output-style name="[^"]*">[\s\S]*?<\/output-style>/;

export function systemPromptWithStyle(base, style) {
  const stripped = String(base || '').replace(STYLE_BLOCK, '');
  if (!style || !style.prompt) return stripped;
  return stripped + '\n\n<output-style name="' + style.name + '">\n' + style.prompt + '\n</output-style>';
}

// Switch the style of a live session; the change applies from the next request.
export function applyOutputStyle(session, style) {
  session.outputStyle = style && style.name || 'default';
  session.baseSystemPrompt = systemPromptWithStyle(session.baseSystemPrompt || session.messages[0].content, style);
  if (session.messages[0] && session.messages[0].role === 'system') {
    session.messages[0].content = systemPromptWithStyle(session.messages[0].content, style);
  }
}
