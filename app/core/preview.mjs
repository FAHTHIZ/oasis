// The Preview panel's address bar: a dev server port or a project file.
/**
 * What the address bar holds: a dev server ("5173", ":5173", "localhost:5173/path",
 * "http://127.0.0.1:3000") or a project file ("index.html", "/docs/").
 */
export function previewTarget(input) {
  const text = String(input || '').trim();
  const portOnly = /^:?(\d{2,5})(\/.*)?$/.exec(text);
  if (portOnly) return { port: Number(portOnly[1]), path: (portOnly[2] || '/').replace(/^\//, '') };
  const local = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(\d{2,5}))?(\/.*)?$/i.exec(text);
  if (local) return { port: Number(local[1] || 80), path: (local[2] || '/').replace(/^\//, '') };
  return { port: null, path: text.replace(/^\.?\/+/, '') };
}
