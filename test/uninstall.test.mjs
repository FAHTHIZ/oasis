import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveUninstallPlan } from '../src/uninstall.mjs';

test('uninstall plan targets only the expected package in a global npm prefix', () => {
  const prefix = path.join(os.tmpdir(), 'oasis-global-prefix');
  const root = path.join(prefix, 'lib', 'node_modules', 'oasis-oss');
  const plan = resolveUninstallPlan(root, { name: 'oasis-oss' });
  assert.equal(plan.applicationRoot, path.resolve(root));
  assert.equal(plan.prefix, path.resolve(prefix));
  assert.deepEqual(plan.args, ['uninstall', '--global', '--prefix', path.resolve(prefix), 'oasis-oss']);
});

test('uninstall refuses project checkouts and local source directories', () => {
  for (const root of [
    path.join(os.tmpdir(), 'project', 'src'),
    path.join(os.tmpdir(), 'oasis'),
    path.join(os.tmpdir(), 'project', 'node_modules', 'not-oasis')
  ]) {
    assert.throws(() => resolveUninstallPlan(root, { name: 'oasis-oss' }), /global npm installation.*will not delete project files/i);
  }
});

test('uninstall refuses a different package even inside node_modules', () => {
  const root = path.join(os.tmpdir(), 'global', 'node_modules', 'another-package');
  assert.throws(() => resolveUninstallPlan(root, { name: 'another-package' }), /package name was not oasis-oss/i);
});

test('uninstall never targets project files or user data paths', () => {
  const prefix = path.join(os.tmpdir(), 'oasis-global-prefix');
  const root = path.join(prefix, 'node_modules', 'oasis-oss');
  const plan = resolveUninstallPlan(root, { name: 'oasis-oss' });
  assert.ok(plan.args.includes('--global'));
  assert.ok(!plan.args.includes(path.join(os.tmpdir(), 'projects')));
  assert.ok(!plan.args.includes(path.join(os.tmpdir(), '.config', 'oasis')));
});
