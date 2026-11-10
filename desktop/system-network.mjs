// The desktop app is usually started from the dock or Start menu, not a shell, so
// HTTPS_PROXY is rarely set even on networks that require a proxy. Two things fix
// that without any setup:
//   - the operating system's proxy settings (including PAC files), read through
//     Electron's session.resolveProxy, become HTTPS_PROXY / HTTP_PROXY for the agent;
//   - certificates in the operating system's trust store (where IT departments put
//     the root CA of a TLS-inspecting proxy) are trusted alongside Node's bundle.
// Variables you set yourself always win. OASIS_PROXY=0 and OASIS_SYSTEM_CA=0 opt out.

/** First usable proxy in a PAC-style result ("PROXY h:p; DIRECT"), as a URL, or null for DIRECT/SOCKS. */
export function proxyFromPacResult(result) {
  for (const part of String(result || '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [kind, hostPort] = tokens;
    if (!kind) continue;
    if (tokens.length > 2) continue;
    const upper = kind.toUpperCase();
    if (upper === 'DIRECT') return null;
    if ((upper === 'PROXY' || upper === 'HTTP' || upper === 'HTTPS') && hostPort && /^[\w.-]+(?::\d+)?$|^\[[0-9a-f:]+\](?::\d+)?$/i.test(hostPort)) {
      return (upper === 'HTTPS' ? 'https://' : 'http://') + hostPort;
    }
    // SOCKS entries are skipped: the agent's proxy layer speaks HTTP CONNECT only.
  }
  return null;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/**
 * Copy the system proxy into each env object (process.env and the agent's env).
 * Returns the proxy URL applied, or null.
 */
export async function applySystemProxy({ session, envs = [process.env], probeUrl = 'https://api.anthropic.com/' } = {}) {
  const env = envs[0] || process.env;
  if (env.OASIS_PROXY === '0' || PROXY_VARS.some((name) => env[name])) return null;
  if (!session || typeof session.resolveProxy !== 'function') return null;
  let proxy = null;
  try { proxy = proxyFromPacResult(await session.resolveProxy(probeUrl)); } catch { return null; }
  if (!proxy) return null;
  for (const target of envs) {
    target.HTTPS_PROXY = proxy;
    target.HTTP_PROXY = proxy;
  }
  return proxy;
}

/**
 * Trust the OS certificate store in addition to Node's bundled roots (Node 22.19+/24.5+,
 * which Electron 45 ships). Returns the number of certificates added, or 0.
 */
export function useSystemCertificates(tls, env = process.env) {
  if (env.OASIS_SYSTEM_CA === '0') return 0;
  if (!tls || typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return 0;
  try {
    const current = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const merged = [...new Set([...current, ...system])];
    const added = merged.length - current.length;
    if (added > 0) tls.setDefaultCACertificates(merged);
    return Math.max(0, added);
  } catch {
    return 0;
  }
}
