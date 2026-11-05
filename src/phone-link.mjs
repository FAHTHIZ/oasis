// "Connect a phone": extra listeners that hand phone connections to an
// already-running OASIS web server, so the phone shares the same chats, jobs
// and approvals as the desktop window instead of starting a second server.
//
// Security model: the main server stays bound to loopback. A phone listener is
// opened only on specific private addresses (never 0.0.0.0) and only on request.
// Tailscale addresses are preferred because WireGuard encrypts the traffic; a
// plain Wi-Fi address is unencrypted HTTP, so callers must obtain explicit consent
// before passing `allowUnencrypted: true`. The bearer token still guards every
// API call, and loopback-only APIs stay unavailable to the phone.
import net from 'node:net';
import { encodeQr } from './qr.mjs';
import { lanAddresses } from './lan-addresses.mjs';

export function phoneNetworks(interfaces) {
  const all = lanAddresses(interfaces).filter((entry) => !entry.virtual);
  return {
    tailscale: all.filter((entry) => entry.tailscale),
    lan: all.filter((entry) => !entry.tailscale)
  };
}

export function phoneUrl({ address, port, token, scheme = 'http' }) {
  const host = address.includes(':') ? '[' + address + ']' : address;
  return scheme + '://' + host + ':' + port + '/' + (token ? '#token=' + encodeURIComponent(token) : '');
}

// A scalable SVG with one path, black on white with a 4-module quiet zone.
export function qrSvg(text, { quiet = 4, ecl = 'M' } = {}) {
  const { size, modules } = encodeQr(text, { ecl });
  const dim = size + quiet * 2;
  let d = '';
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) { x += 1; continue; }
      let run = 1;
      while (x + run < size && modules[y][x + run]) run += 1;
      d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h' + run + 'v1h-' + run + 'z';
      x += run;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    '<rect width="' + dim + '" height="' + dim + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
}

function listenOn(server, address, port) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      server.emit('connection', socket);
    });
    // Stopping the link must also disconnect phones that are already connected.
    proxy.dropClients = () => { for (const socket of sockets) socket.destroy(); };
    proxy.once('error', reject);
    proxy.listen(port, address, () => { proxy.off('error', reject); resolve(proxy); });
  });
}

// Manages at most one active phone link for a running app ({ server, token }).
export function createPhoneLink(app, { interfaces, port: preferredPort = 0, scheme = 'http', resolveBindAddress = (address) => address } = {}) {
  let active = null;

  function status() {
    const networks = phoneNetworks(typeof interfaces === 'function' ? interfaces() : interfaces);
    const base = {
      tailscaleAvailable: networks.tailscale.length > 0,
      lanAvailable: networks.lan.length > 0,
      networks: { tailscale: networks.tailscale.map((e) => e.address), lan: networks.lan.map((e) => e.address) }
    };
    if (!active) return { ...base, active: false };
    return { ...base, active: true, network: active.network, encrypted: active.encrypted, urls: active.urls, qr: active.qr, startedAt: active.startedAt };
  }

  async function start({ network = 'tailscale', allowUnencrypted = false } = {}) {
    if (active && active.network === network) return status();
    await stop();
    const networks = phoneNetworks(typeof interfaces === 'function' ? interfaces() : interfaces);
    const entries = network === 'lan' ? networks.lan : networks.tailscale;
    if (network !== 'lan' && network !== 'tailscale') throw new Error('Unknown network: choose tailscale or lan.');
    if (!entries.length) {
      throw new Error(network === 'tailscale'
        ? 'Tailscale is not connected on this computer. Install it from tailscale.com, sign in on this computer and the phone, then try again.'
        : 'No private Wi-Fi or Ethernet address was found on this computer.');
    }
    if (network === 'lan' && scheme !== 'https' && allowUnencrypted !== true) {
      throw new Error('Wi-Fi links are unencrypted. Confirm the warning before sharing over Wi-Fi.');
    }
    const servers = [];
    let port = preferredPort;
    try {
      for (const entry of entries.slice(0, 3)) {
        const proxy = await listenOn(app.server, resolveBindAddress(entry.address), port);
        servers.push({ proxy, address: entry.address });
        // Use one port on every address so the phone link is easy to read.
        if (!port) port = proxy.address().port;
      }
    } catch (error) {
      for (const { proxy } of servers) proxy.close();
      throw new Error('Could not open a phone link: ' + (error && error.message || error));
    }
    const urls = servers.map(({ address }) => phoneUrl({ address, port, token: app.token, scheme }));
    active = {
      network, encrypted: network === 'tailscale' || scheme === 'https', servers, urls,
      qr: qrSvg(urls[0]), startedAt: new Date().toISOString()
    };
    return status();
  }

  async function stop() {
    if (!active) return status();
    const closing = active.servers.map(({ proxy }) => new Promise((resolve) => { proxy.close(() => resolve()); proxy.dropClients(); }));
    active = null;
    await Promise.all(closing);
    return status();
  }

  return { status, start, stop };
}
