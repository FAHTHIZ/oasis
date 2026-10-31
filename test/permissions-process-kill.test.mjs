import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand } from '../src/permissions.mjs';

test('commands that close user applications are high risk', () => {
  assert.match(analyzeCommand('taskkill.exe', ['/IM', 'POWERPNT.EXE', '/F']).highRisk, /close or kill applications/);
  assert.match(analyzeCommand('Stop-Process', ['-Name', 'excel']).highRisk, /close or kill applications/);
  assert.match(analyzeCommand('xkill', []).highRisk, /close or kill applications/);
  assert.match(analyzeCommand('fuser', ['-k', '3000/tcp']).highRisk, /close or kill applications/);
  assert.equal(analyzeCommand('fuser', ['3000/tcp']).highRisk, undefined);
  assert.ok(analyzeCommand('osascript', ['-e', 'quit app "Keynote"']).highRisk);
});
