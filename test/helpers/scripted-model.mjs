import { createServer } from 'node:http';

// Scripted OpenAI-compatible model: each entry returns a message for one request.
export async function scriptedModel(t, script) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const step = script[Math.min(requests.length - 1, script.length - 1)];
    const message = typeof step === 'function' ? step(payload, requests) : step;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8, maxCommandSeconds: 10 };
  return { config, requests };
}

export function toolCall(id, name, args) {
  return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

