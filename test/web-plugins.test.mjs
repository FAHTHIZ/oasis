import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

async function files(root, map) {
  for (const [rel, value] of Object.entries(map)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

test('the web app can add a marketplace and install, turn off and remove Claude Code plugins', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-plugins-'));
  const market = path.join(root, 'market');
  await files(market, {
    '.claude-plugin/marketplace.json': { name: 'team', owner: { name: 'Team' }, plugins: [{ name: 'helper', source: './plugins/helper', description: 'Helps with plans' }] },
    'plugins/helper/.claude-plugin/plugin.json': { name: 'helper', version: '0.2.0', description: 'Helps with plans' },
    'plugins/helper/commands/plan.md': '---\ndescription: Plan\n---\nMake a plan.\n'
  });
  const workspace = path.join(root, 'work');
  await mkdir(workspace);
  const app = await startOasisWebServer({ root: workspace, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root }, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port + '/api/plugins';
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const post = async (action, target) => {
    const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ action, target }) });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await fetch(base)).status, 401);
  const empty = await (await fetch(base, { headers })).json();
  assert.deepEqual(empty, { installed: [], marketplaces: [] });

  const added = await post('add-marketplace', market);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.marketplaces[0].name, 'team');
  assert.deepEqual(added.body.marketplaces[0].plugins.map((p) => [p.name, p.installed]), [['helper', false]]);

  const installed = await post('install', 'helper@team');
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(installed.body.installed[0].id, 'helper@team');
  assert.equal(installed.body.installed[0].enabled, true);
  assert.equal(installed.body.installed[0].version, '0.2.0');
  assert.equal(installed.body.marketplaces[0].plugins[0].installed, true);

  const off = await post('disable', 'helper@team');
  assert.equal(off.body.installed[0].enabled, false);
  const on = await post('enable', 'helper');
  assert.equal(on.body.installed[0].enabled, true);

  const removed = await post('uninstall', 'helper@team');
  assert.deepEqual(removed.body.installed, []);

  const bad = await post('explode', 'helper@team');
  assert.equal(bad.status, 400);
  const missing = await post('install', 'nothing@team');
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /nothing/i);
});
