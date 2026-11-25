import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSlashCommandLine } from '../src/cli.mjs';

test('a slash command typed mid-turn is recognised as a command, not a note for the model', () => {
  for (const line of ['/rewind', '/model fast', ' /compact ', '/commit-commands:commit', '/mcp reconnect linear']) assert.equal(isSlashCommandLine(line), true, line);
  for (const line of ['/tmp/x is empty', '//', '/ ', 'use /rewind later', '', '/123']) assert.equal(isSlashCommandLine(line), false, line);
});

test('an MCP server waiting for sign-in gets one short line in the terminal, without agent instructions', async () => {
  const { mcpFailureLine } = await import('../src/cli.mjs');
  const { authRequiredError } = await import('../src/mcp-oauth.mjs');
  const error = authRequiredError({ name: 'linear', url: 'https://mcp.linear.app/mcp' });
  for (const failure of [{ name: 'linear', error: error.message, code: error.code }, { name: 'linear', error: error.message }]) {
    const line = mcpFailureLine(failure);
    assert.equal(line, '[MCP] linear needs sign-in · run /mcp login linear to connect it');
    assert.doesNotMatch(line, /connect_service/);
  }
  assert.equal(mcpFailureLine({ name: 'x', error: 'spawn x ENOENT' }), '[MCP] x did not start: spawn x ENOENT');
});
