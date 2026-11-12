import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentDefinitions, taskToolDefinition } from '../src/subagents.mjs';

async function fixture(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-foreign-agents-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  for (const [rel, text] of Object.entries(files)) {
    const file = rel.startsWith('~/') ? path.join(home, rel.slice(2)) : path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  await mkdir(root, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_OTHER_AGENT_RULES: '' };
  return { root, env };
}

test('Gemini CLI and OpenCode agent files become OASIS agents with their tool limits', async (t) => {
  const { root, env } = await fixture(t, {
    '.gemini/agents/security-auditor.md': '---\nname: security-auditor\ndescription: Finds vulnerabilities\nkind: local\ntools:\n  - read_file\n  - grep_search\n  - mcp_*\nmodel: gemini-3-preview\nmax_turns: 12\n---\nYou are a security auditor.',
    '.gemini/agents/anything.md': '---\nname: anything\ndescription: All tools\ntools: ["*"]\n---\nDo anything.',
    '.gemini/agents/remote.md': '---\nname: remote-one\ndescription: A2A\nkind: remote\n---\n',
    '~/.gemini/agents/user-helper.md': '---\nname: user-helper\ndescription: User Gemini agent\n---\nHelp.',
    '.opencode/agents/reviewer.md': '---\ndescription: Reviews code\nmode: subagent\ntools:\n  write: false\n  bash: false\nsteps: 7\nmodel: anthropic/claude-sonnet-4\n---\nReview the changes.',
    '.opencode/agents/docs-writer.md': '---\ndescription: Writes docs\nmode: all\npermissions:\n  - action: shell\n    resource: "*"\n    effect: deny\n  - action: webfetch\n    resource: "*"\n    effect: deny\n  - action: webfetch\n    resource: "*"\n    effect: allow\n---\nWrite docs.',
    '.opencode/agent/builder.md': '---\ndescription: Primary build agent\n---\nBuild things.',
    '.opencode/agents/old.md': '---\ndescription: Disabled\nmode: subagent\ndisable: true\n---\n',
    '~/.config/opencode/agents/planner.md': '---\ndescription: Plans\nmode: subagent\npermission:\n  edit: deny\n---\nPlan.',
    '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Claude reviewer wins\n---\nClaude.'
  });
  const agents = await loadAgentDefinitions(root, { env });
  const auditor = agents['security-auditor'];
  assert.equal(auditor.origin, 'Gemini CLI');
  assert.deepEqual(auditor.tools.sort(), ['ast_grep', 'grep', 'read_file', 'search_files']);
  assert.equal(auditor.maxTurns, 12);
  assert.equal(auditor.model, null);
  assert.equal(auditor.prompt, 'You are a security auditor.');
  assert.equal(agents.anything.tools, null);
  assert.equal(agents['remote-one'], undefined);
  assert.ok(agents['user-helper']);
  // Native .claude/agents wins a name clash.
  assert.equal(agents.reviewer.description, 'Claude reviewer wins');
  const writer = agents['docs-writer'];
  assert.equal(writer.origin, 'OpenCode');
  assert.ok(writer.disallowedTools.includes('run_shell'));
  assert.equal(writer.disallowedTools.includes('fetch_url'), false, 'the later allow rule wins');
  assert.equal(writer.subagentAllowed, true);
  assert.equal(agents.builder.subagentAllowed, false, 'mode defaults to primary');
  assert.equal(agents.old, undefined);
  assert.ok(agents.planner.disallowedTools.includes('edit_file'));
  const schema = taskToolDefinition(agents).function.parameters.properties.subagent_type.enum;
  assert.ok(schema.includes('security-auditor') && schema.includes('docs-writer') && schema.includes('planner'));
  assert.equal(schema.includes('builder'), false);
  const off = await loadAgentDefinitions(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' } });
  assert.equal(off['security-auditor'], undefined);
});

test('OpenCode V1 tools map turns off write and shell tools', async (t) => {
  const { root, env } = await fixture(t, { '.opencode/agents/reviewer.md': '---\ndescription: Reviews code\nmode: subagent\ntools:\n  write: false\n  bash: false\nsteps: 7\n---\nReview.' });
  const reviewer = (await loadAgentDefinitions(root, { env })).reviewer;
  assert.ok(reviewer.disallowedTools.includes('write_file') && reviewer.disallowedTools.includes('run_shell'));
  assert.equal(reviewer.maxTurns, 7);
  assert.equal(reviewer.model, null);
});

test('OpenCode and Kilo Code agents defined inline in opencode.json / kilo.jsonc load as OASIS agents', async (t) => {
  const { root, env } = await fixture(t, {
    'opencode.jsonc': '{\n  // project agents\n  "agent": {\n    "code-reviewer": { "description": "Reviews code", "mode": "subagent", "prompt": "{file:./prompts/review.txt}", "tools": { "write": false, "edit": false }, },\n    "build": { "model": "anthropic/claude-sonnet-4" },\n    "leaky": { "description": "Escapes", "prompt": "{file:../outside.txt}" },\n    "off": { "description": "Off", "prompt": "x", "disable": true },\n    "file-wins": { "description": "JSON version", "prompt": "json" }\n  },\n  "agents": { "auditor": { "description": "Audits", "system": "Report findings in severity order.", "permissions": [{ "action": "edit", "resource": "*", "effect": "deny" }] } }\n}',
    'prompts/review.txt': 'Review carefully.',
    '../outside.txt': 'secret',
    '.opencode/agents/file-wins.md': '---\ndescription: File version\n---\nfile',
    '~/.config/opencode/opencode.json': '{"agent": {"helper": {"description": "User helper", "prompt": "{file:~/notes/helper.md}"}}}',
    '~/notes/helper.md': 'Help the user.',
    '~/.config/kilo/kilo.jsonc': '{"agent": {"kilo-one": {"description": "Kilo agent", "prompt": "Kilo body", "steps": 5}}}'
  });
  const agents = await loadAgentDefinitions(root, { env });
  const reviewer = agents['code-reviewer'];
  assert.equal(reviewer.origin, 'OpenCode');
  assert.match(reviewer.prompt || reviewer.body || JSON.stringify(reviewer), /Review carefully/);
  assert.ok(!reviewer.tools || !reviewer.tools.includes('write_file'));
  assert.equal(agents.build, undefined);
  assert.equal(agents.leaky, undefined);
  assert.equal(agents.off, undefined);
  assert.equal(agents['file-wins'].description, 'File version');
  assert.equal(agents.auditor.description, 'Audits');
  assert.match(JSON.stringify(agents.auditor), /severity order/);
  assert.match(JSON.stringify(agents.helper), /Help the user/);
  assert.equal(agents['kilo-one'].origin, 'Kilo Code');
  assert.equal(agents['kilo-one'].maxTurns, 5);
  const off = await loadAgentDefinitions(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' } });
  assert.equal(off['code-reviewer'], undefined);
});
