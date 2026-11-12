// Electron grants every web permission request by default. OASIS's window only ever shows
// its own local server, and only needs the microphone (dictation), clipboard writes and
// "turn finished" notifications, so everything else (camera, location, MIDI, HID, serial,
// USB, screen capture, pointer lock, ...) is refused, and nothing is granted to any other
// origin.

const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);

function originOf(url) {
  try { return new URL(String(url || '')).origin; } catch { return ''; }
}

/** Decides a permission request (setPermissionRequestHandler) or check (setPermissionCheckHandler). */
function allowPermission(permission, details = {}, appOrigin = '') {
  const origin = originOf(details.requestingUrl || details.securityOrigin || details.embeddingOrigin || '');
  if (!appOrigin || origin !== appOrigin) return false;
  if (details.isMainFrame === false) return false;
  if (ALWAYS.has(permission)) return true;
  if (permission === 'media') {
    // A request lists mediaTypes; a check names one mediaType. Audio only.
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : details.mediaType ? [details.mediaType] : [];
    return types.length > 0 && types.every((type) => type === 'audio');
  }
  return false;
}

export function installPermissionPolicy(session, getOrigin) {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowPermission(permission, details, getOrigin()));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => allowPermission(permission, { ...details, requestingUrl: (details && details.requestingUrl) || requestingOrigin }, getOrigin()));
  if (typeof session.setDevicePermissionHandler === 'function') session.setDevicePermissionHandler(() => false);
}
