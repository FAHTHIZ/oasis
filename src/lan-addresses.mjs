// Private network addresses of this computer, for printing a phone link that
// works on the same Wi-Fi (or Tailscale, which uses 100.64.0.0/10).
import os from 'node:os';

export function isPrivateIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'number' ? (entry.family === 4 ? 'IPv4' : 'IPv6') : entry.family;
      if (family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) continue;
      // Docker and VM bridges are rarely reachable from a phone: list them last.
      const virtual = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|lxc|cni|flannel)/i.test(name);
      const tailscale = entry.address.startsWith('100.') || /tailscale/i.test(name);
      found.push({ name, address: entry.address, virtual, tailscale });
    }
  }
  return found.sort((x, y) => Number(x.virtual) - Number(y.virtual) || Number(x.tailscale) - Number(y.tailscale));
}
