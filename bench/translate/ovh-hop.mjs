// Keyless OVH hop for the benchmark: no auth headers, drops request fields OVH
// rejects, and logs (model requested, model served, status) for each call.
import http from 'node:http'; import https from 'node:https'; import { appendFileSync } from 'node:fs';
const DROP = ['prompt_cache_key', 'safety_identifier', 'user'];
const LOG = process.env.STRIP_LOG || '/tmp/ll/ovh.jsonl';

// Codex CLI sends two leading `developer` messages, which LiteLLM turns into
// two system messages. Qwen3.5's chat template rejects that ("System message
// must be at the beginning."), and on a streamed Responses call LiteLLM turned
// the error into an empty 200 reply, so Codex ended every Qwen3.5 task in 31 s
// with 0 tokens. Merge a leading run of system messages into one; the text and
// its order are unchanged, so every agent sees the same thing.
export function mergeLeadingSystemMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let end = 0;
  while (end < messages.length && messages[end] && messages[end].role === 'system') end += 1;
  if (end < 2) return messages;
  const text = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '').join('') : '';
  return [{ role: 'system', content: messages.slice(0, end).map((message) => text(message.content)).filter(Boolean).join('\n\n') }, ...messages.slice(end)];
}

function serve() { http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    let body = Buffer.concat(chunks); let model = null;
    if (body.length && /json/.test(req.headers['content-type'] || '')) { try { const j = JSON.parse(body); for (const k of DROP) delete j[k]; if (Array.isArray(j.include)) { j.include = j.include.filter((x) => x !== 'reasoning.encrypted_content'); if (!j.include.length) delete j.include; } j.messages = mergeLeadingSystemMessages(j.messages); if (j.messages === undefined) delete j.messages; model = j.model; body = Buffer.from(JSON.stringify(j)); } catch {} }
    const headers = { ...req.headers, 'content-length': body.length }; delete headers.authorization; delete headers['x-api-key']; delete headers.host;
    const started = Date.now();
    const up = https.request({ hostname: 'oai.endpoints.kepler.ai.cloud.ovh.net', path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); let served = null; let head = '';
      r.on('data', (c) => { if (!served && head.length < 65536) { head += c.toString('utf8'); const m = /"model"\s*:\s*"([^"]+)"/.exec(head); if (m) served = m[1]; } });
      r.on('end', () => { try { appendFileSync(LOG, JSON.stringify({ at: new Date(started).toISOString(), path: req.url.split('?')[0], model, served, status: r.statusCode, ms: Date.now() - started }) + '\n'); } catch {} });
      r.pipe(res);
    });
    up.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
    up.end(body);
  });
}).listen(Number(process.env.STRIP_PORT || 4003), '127.0.0.1'); }

if (import.meta.url === 'file://' + process.argv[1]) serve();
