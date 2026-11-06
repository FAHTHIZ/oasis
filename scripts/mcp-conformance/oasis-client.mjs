// OASIS driver for the official MCP conformance suite (github.com/modelcontextprotocol/conformance).
// The suite starts a mock server per scenario and runs: node oasis-client.mjs <server-url>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const repo = process.env.OASIS_REPO || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
process.env.OASIS_HOME = process.env.OASIS_HOME || mkdtempSync(join(tmpdir(), 'oasis-conf-'));
process.env.XDG_CONFIG_HOME = process.env.OASIS_HOME;
process.env.OASIS_NO_BROWSER = '1';
// The suite's authorization server listens on its own loopback port.
process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK = '1';
// The URL the suite's basic-cimd scenario expects as a metadata-document client ID.
if (process.env.MCP_CONFORMANCE_SCENARIO === 'auth/basic-cimd') process.env.OASIS_MCP_CLIENT_METADATA_URL = 'https://conformance-test.local/client-metadata.json';
// Stand-in user: accepts every elicitation with no typed answers, so schema defaults apply.
const host = { session: { sessionId: 'conformance', elicit: async () => ({ action: 'accept', content: {} }) } };
const { McpHttpClient } = await import(repo + '/src/mcp-project.mjs');
const { loginMcpServer } = await import(repo + '/src/mcp-oauth.mjs');
const url = process.argv[process.argv.length - 1];
const scenario = process.env.MCP_CONFORMANCE_SCENARIO || '';
const ctx = process.env.MCP_CONFORMANCE_CONTEXT ? JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT) : {};
const server = { name: 'conf', type: 'http', url, ...(ctx.client_id ? { oauth: { clientId: ctx.client_id, clientSecret: ctx.client_secret } } : {}) };
const headlessOpen = async (authUrl) => {
  const r = await fetch(authUrl, { redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) throw new Error('no redirect from authorize: HTTP ' + r.status);
  await fetch(loc);
};
async function connect(scope = '') {
  const client = new McpHttpClient(server, { host });
  try { if (scope) throw Object.assign(new Error('step-up'), { code: 'MCP_AUTH_REQUIRED' }); await client.start(); return client; }
  catch (e) {
    if (e.code !== 'MCP_AUTH_REQUIRED') throw e;
    client.close();
    await loginMcpServer(server, { scope, open: (u) => { headlessOpen(u).catch((err) => console.error('open failed', err)); }, timeoutMs: 20000 });
    const again = new McpHttpClient(server, { host });
    await again.start();
    return again;
  }
}
const client = await connect();
const tools = client.tools;
console.error('tools:', tools.map((t) => t.name).join(','));
if (scenario === 'json-schema-ref-no-deref') { /* list only */ }
else if (scenario === 'json-schema-2020-12-preservation') {
  const t = tools.find((x) => x.name === 'json_schema_2020_12_tool');
  await client.callTool('json_schema_echo', { schema: t.inputSchema }, { autoApprove: true });
} else if (scenario.startsWith('auth/')) {
  let current = client;
  for (let i = 0; ; i++) {
    try { await current.callTool('test-tool', {}, { autoApprove: true }); break; }
    catch (e) { if (e.code !== 'MCP_AUTH_REQUIRED' || i >= 3) throw e; current.close(); current = await connect(e.requiredScope || 'retry'); }
  }
} else if (scenario.startsWith('elicitation')) {
  await client.callTool('test_client_elicitation_defaults', {}, { autoApprove: true });
} else if (tools[0]) {
  const r = await client.callTool(tools[0].name, { a: 2, b: 3 }, { autoApprove: true });
  console.error('call:', JSON.stringify(r).slice(0, 200));
}
client.close();
process.exit(0);
