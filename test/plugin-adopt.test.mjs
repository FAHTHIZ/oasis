import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, utimes, readdir } from 'node:fs/promises';
import { findAdoptable, adoptCli } from '../src/plugin-adopt.mjs';

async function setup(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-adopt-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); const root = path.join(base, 'repo');
  await mkdir(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(home, rel)), { recursive: true });
    await writeFile(path.join(home, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_OTHER_AGENT_RULES: '0' };
  delete env.CODEX_HOME; delete env.COPILOT_HOME; delete env.GEMINI_HOME;
  return { base, home, root, env };
}

const skill = (name) => '---\nname: ' + name + '\ndescription: ' + name + ' skill\n---\nDo ' + name + '.\n';

test('adopt finds plugins installed in Gemini CLI, Codex and Copilot CLI and installs them through oasis add', async (t) => {
  const { home, root, env } = await setup(t, {
    '.gemini/extensions/greeter/gemini-extension.json': { name: 'greeter', version: '1.2.0', description: 'Says hi' },
    '.gemini/extensions/greeter/commands/hi.toml': 'description = "Say hi"\nprompt = "Say hi to {{args}}"\n',
    '.gemini/extensions/extension-enablement.json': {},
    '.codex/plugins/cache/market/linter/1.0.0/.codex-plugin/plugin.json': { name: 'linter', version: '1.0.0', skills: './skills/' },
    '.codex/plugins/cache/market/linter/1.0.0/skills/lint/SKILL.md': skill('lint'),
    '.codex/plugins/cache/market/linter/2.0.0/.codex-plugin/plugin.json': { name: 'linter', version: '2.0.0', skills: './skills/' },
    '.codex/plugins/cache/market/linter/2.0.0/skills/lint/SKILL.md': skill('lint'),
    '.copilot/installed-plugins/awesome/helper/plugin.json': { name: 'helper', version: '0.1.0', description: 'Helps' },
    '.copilot/installed-plugins/awesome/helper/skills/help/SKILL.md': skill('help')
  });
  const old = path.join(home, '.codex/plugins/cache/market/linter/1.0.0');
  await utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const found = await findAdoptable({ env });
  const by = Object.fromEntries(found.map((p) => [p.source + ':' + p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['codex:linter', 'copilot:helper', 'gemini:greeter']);
  assert.equal(by['codex:linter'].version, '2.0.0');
  assert.equal(by['gemini:greeter'].format, 'Gemini CLI extension');

  let text = '';
  const write = (s) => { text += s; };
  const listed = await adoptCli(root, ['--list'], { write, env });
  assert.equal(listed.installed.length, 0);
  assert.match(text, /gemini:greeter/);
  text = '';
  await adoptCli(root, [], { write, env });
  assert.match(text, /--yes/);

  text = '';
  const result = await adoptCli(root, ['greeter', '--yes'], { write, env });
  assert.ok(result.installed.length >= 1, text);
  assert.match(text, /Adopted gemini:greeter/);
  // The other agent's files are untouched.
  assert.deepEqual((await readdir(path.join(home, '.gemini/extensions/greeter'))).sort(), ['commands', 'gemini-extension.json']);
  await assert.rejects(adoptCli(root, ['nothing-like-this', '--yes'], { write, env }), /None of/);
  await assert.rejects(findAdoptable({ env, from: ['emacs'] }), /Unknown agent/);
});
