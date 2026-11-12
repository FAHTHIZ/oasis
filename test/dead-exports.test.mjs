import test from 'node:test';
import assert from 'node:assert/strict';

// Exports removed as dead code: nothing in the repo imported them. The modules must still load.
const REMOVED = {
  '../app/core/timeline.mjs': ['STEP_KINDS'],
  '../src/frontmatter.mjs': ['stringifyYaml'],
  '../src/monitors.mjs': ['MONITOR_TOOL_DEFINITION'],
  '../src/power-tools.mjs': ['NOTEBOOK_EDIT_DEFINITION', 'POWER_TOOL_DEFINITIONS', 'POWER_TOOL_NAMES']
};

for (const [file, names] of Object.entries(REMOVED)) {
  test(`${file} loads without its dead exports`, async () => {
    const mod = await import(file);
    for (const name of names) assert.equal(name in mod, false, `${name} is still exported`);
  });
}

test('power-tools still re-exports the shell tool definitions agent.mjs uses', async () => {
  const mod = await import('../src/power-tools.mjs');
  assert.equal(mod.SHELL_TOOL_DEFINITION.function.name, 'run_shell');
  assert.ok(mod.POWERSHELL_TOOL_DEFINITION);
});
