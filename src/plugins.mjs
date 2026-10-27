import path from 'node:path';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(APP_ROOT, 'plugins', 'catalog.json');
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function readCatalog() {
  const parsed = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
    throw new Error('The built-in plugin catalog has an unsupported format.');
  }
  const seen = new Set();
  for (const plugin of parsed.plugins) {
    if (!plugin || !NAME_PATTERN.test(plugin.name) || seen.has(plugin.name) ||
        typeof plugin.description !== 'string' || !Array.isArray(plugin.skills) ||
        plugin.skills.some((skill) => !NAME_PATTERN.test(skill))) {
      throw new Error('The built-in plugin catalog contains an invalid entry.');
    }
    seen.add(plugin.name);
  }
  return parsed.plugins;
}

async function pathExists(target) {
  try { await access(target); return true; } catch { return false; }
}

function workspacePaths(root) {
  const oasisRoot = path.join(root, '.oasis');
  return {
    oasisRoot,
    pluginsRoot: path.join(oasisRoot, 'plugins'),
    skillsRoot: path.join(oasisRoot, 'skills')
  };
}

async function readInstalled(root) {
  const { pluginsRoot } = workspacePaths(root);
  let entries = [];
  try { entries = await readdir(pluginsRoot, { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, 'plugin.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === entry.name && Array.isArray(manifest.skills)) installed.push(manifest);
    } catch {}
  }
  return installed;
}

export async function managePlugins(root, args = []) {
  const action = String(args[0] || 'list').toLowerCase();
  const catalog = await readCatalog();
  const { pluginsRoot, skillsRoot } = workspacePaths(root);
  if (action === 'list' || action === 'browse') {
    const installed = await readInstalled(root);
    const installedNames = new Set(installed.map((plugin) => plugin.name));
    process.stdout.write('Oasis capability catalog (bundled, reviewed text-based skill bundles)\n\n');
    for (const plugin of catalog) {
      process.stdout.write((installedNames.has(plugin.name) ? '[installed] ' : '[available] ') +
        plugin.name + ' — ' + plugin.description + '\n  Skills: ' + plugin.skills.join(', ') + '\n');
    }
    if (!catalog.length) process.stdout.write('No built-in plugins are available.\n');
    process.stdout.write('\nInstall with: oasis plugins install NAME\n');
    process.stdout.write('External services are configured separately with oasis mcp; Oasis will not run third-party plugin code silently.\n');
    return;
  }

  const name = String(args[1] || '').toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    throw new Error('Usage: oasis plugins ' + (action === 'remove' ? 'remove' : 'install') + ' NAME. Use "oasis plugins list" to browse.');
  }
  if (action === 'install') {
    const plugin = catalog.find((item) => item.name === name);
    if (!plugin) throw new Error('No built-in plugin named "' + name + '". Run oasis plugins list to browse available bundles.');
    if ((await readInstalled(root)).some((item) => item.name === name)) {
      process.stdout.write('Plugin "' + name + '" is already installed in this workspace.\n');
      return;
    }

    const sources = [];
    for (const skill of plugin.skills) {
      const source = path.join(APP_ROOT, 'skills', skill, 'SKILL.md');
      if (!source.startsWith(path.join(APP_ROOT, 'skills') + path.sep) || !(await pathExists(source))) {
        throw new Error('Plugin "' + name + '" references missing bundled skill "' + skill + '". No files were installed.');
      }
      sources.push({ skill, source, destination: path.join(skillsRoot, skill, 'SKILL.md') });
    }

    await mkdir(pluginsRoot, { recursive: true });
    await mkdir(skillsRoot, { recursive: true });
    const installedSkills = [];
    try {
      for (const item of sources) {
        if (await pathExists(item.destination)) {
          installedSkills.push({ name: item.skill, owned: false });
          continue;
        }
        await mkdir(path.dirname(item.destination), { recursive: true });
        await copyFile(item.source, item.destination);
        installedSkills.push({ name: item.skill, owned: true });
      }
      const manifest = {
        schemaVersion: 1,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        installedAt: new Date().toISOString(),
        skills: installedSkills,
        trust: 'bundled-with-oasis'
      };
      await mkdir(path.join(pluginsRoot, name), { recursive: false });
      await writeFile(path.join(pluginsRoot, name, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write('Installed plugin "' + name + '" in ' + path.join(pluginsRoot, name) + '\n');
      process.stdout.write('Skills: ' + plugin.skills.join(', ') + '\n');
      process.stdout.write('This bundle adds workflow instructions only; it does not silently install packages, start servers, or grant external access.\n');
    } catch (error) {
      for (const item of installedSkills) {
        if (item.owned) await rm(path.dirname(path.join(skillsRoot, item.name, 'SKILL.md')), { recursive: true, force: true }).catch(() => {});
      }
      await rm(path.join(pluginsRoot, name), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return;
  }

  if (action === 'remove' || action === 'uninstall') {
    const installed = (await readInstalled(root)).find((item) => item.name === name);
    if (!installed) throw new Error('Plugin "' + name + '" is not installed in this workspace.');
    for (const skill of installed.skills) {
      if (skill.owned && NAME_PATTERN.test(skill.name)) {
        await rm(path.dirname(path.join(skillsRoot, skill.name, 'SKILL.md')), { recursive: true, force: true });
      }
    }
    await rm(path.join(pluginsRoot, name), { recursive: true, force: true });
    process.stdout.write('Removed plugin "' + name + '" and only the skill files it owned.\n');
    return;
  }
  throw new Error('Unknown plugins action "' + action + '". Use list, install, or remove.');
}
