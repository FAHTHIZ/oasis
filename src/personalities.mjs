// Personalities (like Hermes' /personality): the agent's voice and tone, separate from output
// styles (which shape structure) and from instructions (which shape behaviour). A personality
// never changes what the agent does, what it is allowed to do, or how accurate it must be.
//
// Built-ins are below. Add your own with a Markdown file in <config dir>/personalities/NAME.md
// or .oasis/personalities/NAME.md (front matter `description:` optional), or with the
// "personalities" setting: { "personalities": { "butler": "Speak like a formal English butler." } }.
// "personality": "NAME" in settings, OASIS_PERSONALITY or /personality NAME picks one.
import { readdir, readFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { parseFrontMatter } from './frontmatter.mjs';

const MAX_FILE = 16 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

const builtin = (name, description, prompt) => ({ name, description, prompt, source: 'built-in' });

export const BUILTIN_PERSONALITIES = {
  helpful: builtin('helpful', 'Friendly, warm and encouraging', 'Be friendly and warm. Encourage the user, acknowledge good ideas, and keep a positive tone without flattery.'),
  concise: builtin('concise', 'Terse and to the point', 'Be terse. Use the fewest words that fully answer. No pleasantries, no restating the question.'),
  technical: builtin('technical', 'Precise, expert, assumes deep knowledge', 'Speak like a senior engineer to a peer: precise terminology, no hand-holding, cite exact names, versions and numbers.'),
  teacher: builtin('teacher', 'Patient, explains the why with examples', 'Be a patient teacher. Explain the reasoning behind each step, use small concrete examples, and check understanding at natural pauses.'),
  creative: builtin('creative', 'Imaginative, suggests unexpected angles', 'Be imaginative. Offer unexpected angles and vivid analogies, and suggest one bolder alternative when it would help.'),
  mentor: builtin('mentor', 'Candid coach who pushes you to grow', 'Be a candid mentor. Point out weaknesses directly but kindly, ask the question the user should be asking, and suggest what to learn next.'),
  philosopher: builtin('philosopher', 'Thoughtful and reflective', 'Be reflective. Briefly consider the deeper why and the trade-offs before practical answers, in calm measured prose.'),
  hype: builtin('hype', 'High-energy cheerleader', 'Be high-energy and enthusiastic. Celebrate progress and keep momentum, while staying accurate about problems.'),
  noir: builtin('noir', 'Hard-boiled detective narrator', 'Narrate like a hard-boiled 1940s detective: terse, world-weary, with the odd wry simile. Bugs are suspects; logs are witnesses.'),
  pirate: builtin('pirate', 'Talks like a pirate', 'Talk like a pirate: "arr", "matey", nautical metaphors. Keep code, commands and facts exact.'),
  shakespeare: builtin('shakespeare', 'Elizabethan English', 'Speak in light Elizabethan English (thee, thou, doth) with the occasional flourish. Keep code, commands and facts exact.'),
  surfer: builtin('surfer', 'Laid-back surfer', 'Be a laid-back surfer: relaxed, upbeat, "dude", "gnarly", "stoked". Keep code, commands and facts exact.'),
  kawaii: builtin('kawaii', 'Cute and cheerful', 'Be cute and cheerful, with soft enthusiasm and the occasional kaomoji such as (^_^). Keep code, commands and facts exact.')
};

const GUARD = 'This sets only your voice and tone. It never changes your task, your rules, what you may do, or your accuracy; code, commands, file contents and quoted output stay exactly as they must be.';

function personalityDirectories(root, env, home) {
  return [
    { dir: path.join(getConfigDirectory(env, home), 'personalities'), scope: 'user' },
    ...(root ? [{ dir: path.join(path.resolve(root), '.oasis', 'personalities'), scope: 'project' }] : [])
  ];
}

/** All personalities: built-in, then settings, then user files, then project files (later wins). */
export async function loadPersonalities(root, { env = process.env, home = os.homedir(), settings = {} } = {}) {
  const all = { ...BUILTIN_PERSONALITIES };
  const fromSettings = settings && settings.personalities;
  if (fromSettings && typeof fromSettings === 'object' && !Array.isArray(fromSettings)) {
    for (const [raw, value] of Object.entries(fromSettings)) {
      const name = String(raw).trim().toLowerCase();
      const prompt = typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.prompt || value.system_prompt || '') : '';
      if (!NAME_RE.test(name) || !prompt.trim()) continue;
      all[name] = { name, description: String(value && value.description || prompt.split('\n')[0]).slice(0, 120), prompt: prompt.trim().slice(0, 4000), source: 'settings' };
    }
  }
  // A project's own personality files count only once you trust the folder, like its settings.
  let projectTrusted = false;
  if (root) { try { projectTrusted = await (await import('./settings.mjs')).isWorkspaceTrusted(root, env); } catch { projectTrusted = false; } }
  for (const { dir, scope } of personalityDirectories(root, env, home)) {
    if (scope === 'project' && !projectTrusted) continue;
    let names = [];
    try { names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort(); } catch { continue; }
    for (const file of names) {
      const full = path.join(dir, file);
      try {
        const info = await lstat(full);
        if (!info.isFile() || info.size > MAX_FILE) continue;
        const { data, body } = parseFrontMatter(await readFile(full, 'utf8'));
        const name = String(data.name || file.slice(0, -3)).trim().toLowerCase();
        if (!NAME_RE.test(name) || !body.trim()) continue;
        all[name] = { name, description: String(data.description || body.trim().split('\n')[0]).slice(0, 120), prompt: body.trim(), source: scope, file: full };
      } catch { /* skip unreadable files */ }
    }
  }
  return all;
}

const BLOCK = /\n\n<personality name="[^"]*">[\s\S]*?<\/personality>/;

export function systemPromptWithPersonality(base, personality) {
  const stripped = String(base || '').replace(BLOCK, '');
  if (!personality || !personality.prompt) return stripped;
  return stripped + '\n\n<personality name="' + personality.name + '">\n' + personality.prompt + '\n' + GUARD + '\n</personality>';
}

/** Switch a live session's personality (null or "none" turns it off); applies from the next request. */
export function applyPersonality(session, personality) {
  session.personality = personality && personality.prompt ? personality.name : 'none';
  for (const key of ['baseSystemPrompt', 'mcpSystemPromptBase']) {
    if (typeof session[key] === 'string' && session[key]) session[key] = systemPromptWithPersonality(session[key], personality);
  }
  if (session.messages && session.messages[0] && session.messages[0].role === 'system') {
    session.messages[0].content = systemPromptWithPersonality(session.messages[0].content, personality);
  }
}

/** `/personality [NAME|none]`, shared by the terminal, web app and chat gateways. */
export async function personalityCommand(argument, { session, root, env = process.env, settings = {} } = {}) {
  const all = await loadPersonalities(root, { env, settings });
  const requested = String(argument || '').trim().toLowerCase();
  const active = session && session.personality || 'none';
  if (!requested || requested === 'list') {
    const lines = ['Personalities (' + (active === 'none' ? 'none active' : active + ' active') + '):'];
    for (const item of Object.values(all)) lines.push((item.name === active ? '* ' : '  ') + item.name + ' - ' + item.description + (item.source === 'built-in' ? '' : ' [' + item.source + ']'));
    lines.push('Use /personality NAME, or /personality none to turn it off. Add your own in .oasis/personalities/NAME.md.');
    return lines.join('\n');
  }
  if (['none', 'off', 'default', 'reset', 'clear'].includes(requested)) {
    if (session) applyPersonality(session, null);
    return 'Personality off.';
  }
  const chosen = all[requested];
  if (!chosen) return 'Unknown personality "' + requested + '". Run /personality to list them.';
  if (!session) return 'Personality ' + chosen.name + ' applies to the next session.';
  applyPersonality(session, chosen);
  return 'Personality set to ' + chosen.name + '.';
}
