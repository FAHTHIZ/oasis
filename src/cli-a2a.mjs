// oasis a2a serve | card | send: the A2A protocol from the command line.
import { serveA2a, fetchAgentCard, pickInterface, A2aClient, partsText, stateTo03, isLoopbackHost } from './a2a.mjs';

export const A2A_USAGE = [
  'Usage:',
  '  oasis a2a serve [--host HOST] [--port N] [--public-url URL] [--permission-mode MODE] [--no-auth]',
  '  oasis a2a card URL [--token TOKEN] [--json]',
  '  oasis a2a send URL MESSAGE [--token TOKEN] [--context ID] [--task ID] [--json]'
].join('\n');

function flag(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' needs a value.\n' + A2A_USAGE);
  args.splice(at, 2);
  return value;
}

function boolFlag(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

export async function a2aCommand(rest, { root, env = process.env, stdout = process.stdout, stderr = process.stderr, version = '', permissionMode = null, waitForStop } = {}) {
  const args = [...rest];
  const sub = args.shift();
  if (sub === 'serve') {
    const host = flag(args, '--host') || env.OASIS_A2A_HOST || '127.0.0.1';
    const portText = flag(args, '--port') || env.OASIS_A2A_PORT || '41241';
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number.');
    const publicUrl = flag(args, '--public-url') || env.OASIS_A2A_PUBLIC_URL || '';
    const mode = flag(args, '--permission-mode') || permissionMode || null;
    if (mode && !['default', 'acceptEdits', 'plan', 'auto'].includes(mode)) throw new Error('oasis a2a serve --permission-mode must be default, acceptEdits, plan or auto.');
    const noAuth = boolFlag(args, '--no-auth');
    if (args.length) throw new Error('Unknown argument ' + args[0] + '.\n' + A2A_USAGE);
    const server = await serveA2a({ root, env, host, port, publicUrl, permissionMode: mode, noAuth, version, log: (line) => stderr.write('[a2a] ' + line + '\n') });
    stderr.write('OASIS A2A agent for ' + root + '\n');
    stderr.write('  Agent Card: ' + server.url + '.well-known/agent-card.json\n');
    stderr.write('  JSON-RPC:   ' + server.url + ' (A2A 1.0 and 0.3)\n');
    if (server.token) stderr.write('  Token:      ' + (env.OASIS_A2A_TOKEN ? '(from OASIS_A2A_TOKEN)' : server.token) + '\n  Clients send: Authorization: Bearer <token>\n');
    else stderr.write('  No token: only programs on this computer can reach it.\n');
    if (!isLoopbackHost(host)) stderr.write('  Reachable from the network on ' + host + '. Put it behind HTTPS before exposing it beyond your LAN.\n');
    stderr.write('Approvals: tasks pause as input-required; the client answers yes or no. Ctrl+C stops the server.\n');
    await (waitForStop || (() => new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); })))();
    await server.close();
    return 0;
  }
  if (sub === 'card' || sub === 'send') {
    const token = flag(args, '--token') || env.OASIS_A2A_CLIENT_TOKEN || '';
    const contextId = sub === 'send' ? flag(args, '--context') : null;
    const taskId = sub === 'send' ? flag(args, '--task') : null;
    const json = boolFlag(args, '--json');
    const url = args.shift();
    if (!url) throw new Error(A2A_USAGE);
    const card = await fetchAgentCard(url, { token });
    const chosen = pickInterface(card, url);
    if (sub === 'card') {
      if (json) { stdout.write(JSON.stringify(card, null, 2) + '\n'); return 0; }
      stdout.write(card.name + (card.version ? ' ' + card.version : '') + '\n' + (card.description || '') + '\n\nEndpoint: ' + chosen.url + ' (A2A ' + chosen.version + ')\nStreaming: ' + (card.capabilities && card.capabilities.streaming ? 'yes' : 'no') + '\n');
      for (const skill of card.skills || []) stdout.write('  - ' + skill.id + ': ' + String(skill.description || skill.name || '').slice(0, 160) + '\n');
      return 0;
    }
    const message = args.join(' ').trim();
    if (!message) throw new Error('Give the message to send.\n' + A2A_USAGE);
    const client = new A2aClient({ url: chosen.url, version: chosen.version, token, timeoutMs: Math.max(10, Number(env.OASIS_A2A_TIMEOUT_SECONDS) || 600) * 1000 });
    const reply = await client.send(message, { contextId: contextId || undefined, taskId: taskId || undefined });
    if (json) { stdout.write(JSON.stringify(reply, null, 2) + '\n'); return 0; }
    if (reply.message) { stdout.write(partsText(reply.message.parts) + '\n'); return 0; }
    const task = reply.task;
    const result = (task.artifacts || []).map((artifact) => partsText(artifact.parts)).filter(Boolean).join('\n\n') || (task.status.message ? partsText(task.status.message.parts) : '');
    stdout.write(result + '\n');
    stderr.write('[' + stateTo03(task.status.state) + '] task ' + task.id + (task.contextId ? ', context ' + task.contextId : '') + '\n');
    return task.status.state === 'TASK_STATE_COMPLETED' || task.status.state === 'TASK_STATE_INPUT_REQUIRED' ? 0 : 1;
  }
  stderr.write(A2A_USAGE + '\n');
  return 2;
}
