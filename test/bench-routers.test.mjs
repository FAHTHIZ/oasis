import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseRouterArgs, parseRoute, runRouterBench } from '../scripts/bench-routers.mjs';

test('router routes parse name, base URL, model and key variable, and reject pasted keys', () => {
  assert.deepEqual(parseRoute('omni=http://127.0.0.1:20128/v1/,ovh/gpt-oss-20b,OMNIROUTE_API_KEY'), { name: 'omni', baseUrl: 'http://127.0.0.1:20128/v1', model: 'ovh/gpt-oss-20b', keyEnv: 'OMNIROUTE_API_KEY' });
  assert.throws(() => parseRoute('x=http://h/v1,m,sk-live-abc123'), /environment variable name/);
  assert.throws(() => parseRoute('http://h/v1,m'), /name=/);
  assert.throws(() => parseRouterArgs([]), /at least one --route/);
  assert.equal(parseRouterArgs(['--route', 'a=http://h/v1,m', '--rounds', '2', '--interval-ms', '0']).rounds, 2);
});

function fakeRouter({ brokenTools = false } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    const json = JSON.parse(body);
    if (json.model !== 'm1') { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'model not found' } })); }
    if (json.stream) {
      res.setHeader('content-type', 'text/event-stream');
      for (const word of ['1 2 3 ', '... 20']) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: word } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    const args = brokenTools ? '{"path": "package.js' : '{"path":"package.json"}';
    res.end(JSON.stringify({ model: 'm1', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: args } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: 'http://127.0.0.1:' + server.address().port + '/v1' })));
}

test('router bench scores tool calls, streams, usage and unknown-model errors, and sends keys only as headers', async () => {
  const good = await fakeRouter();
  const broken = await fakeRouter({ brokenTools: true });
  process.env.OASIS_TEST_ROUTER_KEY = 'test-router-key-value';
  try {
    const { summary } = await runRouterBench({
      routes: [parseRoute('good=' + good.url + ',m1,OASIS_TEST_ROUTER_KEY'), parseRoute('broken=' + broken.url + ',m1')],
      rounds: 2, intervalMs: 0, timeoutMs: 5000,
    }, () => {});
    const [g, b] = summary;
    assert.equal(g.toolCalls, '2/2');
    assert.equal(g.streams, '2/2');
    assert.equal(g.usageReported, '4/4');
    assert.equal(g.unknownModel, '404');
    assert.equal(g.listsModel, 'yes');
    assert.equal(b.toolCalls, '0/2', 'truncated tool arguments are a failure');
    assert.ok(good.seen.every((r) => r.auth === 'Bearer test-router-key-value'));
    assert.ok(broken.seen.every((r) => r.auth === ''), 'a route without a key variable sends no Authorization header');
  } finally {
    delete process.env.OASIS_TEST_ROUTER_KEY;
    good.server.close();
    broken.server.close();
  }
});
