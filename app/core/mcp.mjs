// Pure helpers for the MCP servers section of Settings. The runtime validates
// again on save (src/mcp.mjs); these only give fast, specific feedback.

/** Splits a command line into an executable and arguments, honouring quotes. */
export function splitCommandLine(text) {
  const parts = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started || current) parts.push(current); current = ''; started = false; }
    else { current += ch; started = true; }
  }
  if (quote) throw new Error('Close the ' + quote + ' quote in the command.');
  if (started || current) parts.push(current);
  return parts;
}

/** Builds a server entry from the add form, or throws a message for the user. */
export function mcpServerFromForm({ name = '', command = '', env = '' } = {}) {
  const cleanName = String(name).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(cleanName)) throw new Error('Name it with lowercase letters, numbers, - or _, starting with a letter.');
  const parts = splitCommandLine(command);
  if (!parts.length) throw new Error('Enter the command that starts the server, for example npx -y @modelcontextprotocol/server-filesystem .');
  const [executable, ...args] = parts;
  if (!/^[a-zA-Z0-9_./:\\-]+$/.test(executable)) throw new Error('The first word must be a program name or path, not shell syntax.');
  const passEnv = parseEnvNames(env);
  return { name: cleanName, command: executable, args, passEnv, enabled: true };
}

export function parseEnvNames(text) {
  const names = String(text || '').split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  if (names.some((v) => !/^[A-Z_][A-Z0-9_]*$/.test(v))) throw new Error('Environment names must be uppercase, like GITHUB_TOKEN. Enter names only, never the secret values.');
  return [...new Set(names)];
}

/** One-line description of a configured server. */
export function describeMcpServer(server) {
  const args = (server.args || []).map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return [server.command, args].filter(Boolean).join(' ');
}
