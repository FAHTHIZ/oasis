let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}

function handle(message) {
  const params = message.params || {};
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange' || message.method === 'textDocument/didSave') {
    const document = params.textDocument || {};
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: document.uri, diagnostics: [] } });
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') process.exit(0);
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    const length = match ? Number(match[1]) : NaN;
    const bodyStart = headerEnd + 4;
    if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
      buffer = buffer.subarray(bodyStart);
      continue;
    }
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    try { handle(JSON.parse(body)); } catch { /* Ignore malformed test protocol input. */ }
  }
});
