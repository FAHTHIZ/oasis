// Skills for the universal app. Only names and one-line descriptions go into
// the system prompt; a skill's full instructions are fetched the moment the
// agent decides it needs them. That keeps prompts small and lets a phone
// carry dozens of skills at no cost.

import { frontMatterValue } from '../../src/frontmatter.mjs';

const PROJECT_SKILL_DIRS = ['.oasis/skills/', '.agents/skills/', '.claude/skills/'];

export function parseSkill(text, fallbackName = '') {
  const source = String(text || '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = match ? match[1] : '';
  const body = match ? source.slice(match[0].length) : source;
  const name = (frontMatterValue(meta, 'name') || fallbackName).trim();
  const description = frontMatterValue(meta, 'description').replace(/\s+/g, ' ').trim();
  return { name, description, body: body.trim() };
}

export class SkillLibrary {
  /**
   * @param {object} options
   * @param {string} options.baseURL  where skills/index.json and skill folders live
   * @param {Function} [options.fetchImpl]
   * @param {object} [options.workspace]  project workspace for project-local skills
   */
  constructor({ baseURL = '', fetchImpl, workspace = null } = {}) {
    this.baseURL = baseURL.replace(/\/?$/, '/');
    this.fetchImpl = fetchImpl || (globalThis.fetch && globalThis.fetch.bind(globalThis));
    this.workspace = workspace;
    this.index = null;
    this.bodies = new Map();
  }

  setWorkspace(workspace) { this.workspace = workspace; this.index = null; }

  async list() {
    if (this.index) return this.index;
    const skills = new Map();
    try {
      if (this.fetchImpl) {
        const response = await this.fetchImpl(this.baseURL + 'index.json');
        if (response.ok) for (const item of await response.json()) skills.set(item.name, { ...item, origin: 'built-in' });
      }
    } catch { /* offline before the first visit: project skills still work */ }
    if (this.workspace) {
      for (const path of await this.workspace.paths()) {
        const dir = PROJECT_SKILL_DIRS.find((prefix) => path.startsWith(prefix));
        if (!dir || !/\/SKILL\.md$/i.test(path)) continue;
        const folder = path.slice(dir.length).split('/')[0];
        const parsed = parseSkill(await this.workspace.read(path), folder);
        if (parsed.name) skills.set(parsed.name, { name: parsed.name, description: parsed.description, path, origin: 'project' });
      }
    }
    this.index = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.index;
  }

  /** Prompt section listing skills, one line each. */
  async promptSection(limit = 60) {
    const skills = await this.list();
    if (!skills.length) return '';
    const lines = skills.slice(0, limit).map((skill) => '- ' + skill.name + ': ' + (skill.description || '').slice(0, 220));
    return 'Skills (call load_skill with the name before following one; load only what the task needs):\n' + lines.join('\n');
  }

  async load(name) {
    const wanted = String(name || '').trim().replace(/^\//, '');
    const skills = await this.list();
    const skill = skills.find((item) => item.name === wanted) || skills.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
    if (!skill) throw new Error('No skill named "' + wanted + '". Available: ' + skills.map((item) => item.name).join(', '));
    if (this.bodies.has(skill.name)) return this.bodies.get(skill.name);
    let text;
    if (skill.origin === 'project') text = await this.workspace.read(skill.path);
    else {
      const response = await this.fetchImpl(this.baseURL + skill.path);
      if (!response.ok) throw new Error('Could not load skill ' + skill.name + ' (HTTP ' + response.status + ').');
      text = await response.text();
    }
    const parsed = parseSkill(text, skill.name);
    const loaded = { name: skill.name, description: parsed.description, body: parsed.body };
    this.bodies.set(skill.name, loaded);
    return loaded;
  }
}
