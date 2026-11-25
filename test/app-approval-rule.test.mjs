import test from 'node:test';
import assert from 'node:assert/strict';
import { alwaysAllowLabel, alwaysAllowTitle } from '../app/core/approval-rule.mjs';

test('approval rules read as plain words on the Always allow button', () => {
  assert.equal(alwaysAllowLabel('run_command(npm test:*)'), 'Always allow npm test');
  assert.equal(alwaysAllowLabel('run_command(node cart.test.js:*)'), 'Always allow node cart.test.js');
  assert.equal(alwaysAllowLabel('run_command(git:*)'), 'Always allow git commands');
  assert.match(alwaysAllowTitle('run_command(npm test:*)'), /npm test with more arguments/);
  assert.equal(alwaysAllowLabel('run_command(git status)'), 'Always allow git status');
  assert.equal(alwaysAllowLabel('run_command'), 'Always allow commands');
  assert.equal(alwaysAllowLabel('edit_file(src/**)'), 'Always allow edits in src');
  assert.equal(alwaysAllowLabel('write_file'), 'Always allow file edits');
  assert.equal(alwaysAllowLabel('delete_file(tmp/*)'), 'Always allow deletions in tmp');
  assert.equal(alwaysAllowLabel('fetch_url(domain:example.com)'), 'Always allow example.com');
  assert.equal(alwaysAllowLabel('mcp_github_create_issue'), 'Always allow this tool');
  assert.equal(alwaysAllowLabel('install_package(npm:left-pad)'), 'Always allow install package npm:left-pad');
  assert.equal(alwaysAllowLabel('???'), 'Always allow this');
});
