import { createServer } from 'node:http';

// Scripted OpenAI-compatible model: each entry returns a message for one request.
export async function scriptedModel(t, script, { registerTeardown = true } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    try {
      for await (const chunk of req) body += chunk;
    } catch (error) {
      // A caller may close a test session while a request is being aborted.
      // Treat that as an interrupted fixture request, not an unhandled server rejection.
      if (req.aborted || req.destroyed || ['ECONNRESET', 'ECONNABORTED'].includes(error && error.code)) return;
      if (!res.destroyed) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read the scripted model request.' }));
      }
      return;
    }
    if (!body.trim()) {
      if (!res.destroyed) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'The scripted model received an empty request body.' }));
      }
      return;
    }
    let payload;
    try { payload = JSON.parse(body); }
    catch {
      if (!res.destroyed) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'The scripted model received invalid JSON.' }));
      }
      return;
    }
    requests.push(payload);
    const step = script[Math.min(requests.length - 1, script.length - 1)];
    const message = typeof step === 'function' ? await step(payload, requests) : step;
    if (res.destroyed) return;
    res.setHeader('content-type', 'application/json');
    const { finish_reason: finishReason, usage: scriptedUsage, ...reply } = message || {};
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...reply }, ...(finishReason ? { finish_reason: finishReason } : {}) }], usage: scriptedUsage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
  if (registerTeardown) t.after(close);
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8, maxCommandSeconds: 10 };
  return { config, requests, close };
}

export function toolCall(id, name, args) {
  return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

