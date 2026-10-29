// Small, dependency-free recovery page for an Electron renderer crash.
// The renderer is untrusted; escape every diagnostic before placing it in HTML.
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function safeRestartUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return url.href;
    }
  } catch {}
  return 'http://127.0.0.1/';
}

export function crashRecoveryHtml({ reason = 'unknown', exitCode, restartUrl } = {}) {
  const details = [
    'Renderer process stopped unexpectedly.',
    'Reason: ' + String(reason || 'unknown').slice(0, 120),
    'Exit code: ' + (Number.isInteger(exitCode) ? exitCode : 'not provided')
  ].join('\n');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark light"><title>OASIS stopped</title>' +
    '<style>:root{color-scheme:dark;--bg:#0b0f0c;--panel:#142019;--text:#f2f5ee;--muted:#b7c4b8;--line:#344b3a;--lime:#9bff55}' +
    '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top,#203a29,transparent 65%),var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}' +
    'main{width:min(100%,620px);padding:clamp(22px,5vw,38px);border:1px solid var(--line);border-radius:20px;background:var(--panel)}' +
    'h1{margin:0 0 8px;font-size:clamp(27px,5vw,36px);line-height:1.15}p{color:var(--muted)}a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;margin-top:8px;padding:10px 17px;border-radius:11px;background:var(--lime);color:#14200f;font-weight:800;text-decoration:none}' +
    'pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:13px;border:1px solid var(--line);border-radius:10px;color:var(--muted);font:13px/1.55 ui-monospace,monospace}a:focus-visible{outline:3px solid var(--text);outline-offset:3px}</style></head>' +
    '<body><main><p>OASIS DESKTOP</p><h1>OASIS stopped unexpectedly.</h1>' +
    '<p>Your project workspace may still be running. Restart the workspace to try again. If it crashes repeatedly, close OASIS and report these details.</p>' +
    '<a href="' + escapeHtml(safeRestartUrl(restartUrl)) + '">Restart OASIS workspace</a>' +
    '<h2>What happened</h2><pre>' + escapeHtml(details) + '</pre>' +
    '<p>No renderer log lines were available from the crash event. These details identify the reported failure without exposing project files or API keys.</p>' +
    '</main></body></html>';
}
