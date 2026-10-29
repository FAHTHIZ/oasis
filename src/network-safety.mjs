import { isIP } from 'node:net';

function isNonPublicIPv4(address) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127);
}

function parseIPv6(address) {
  let value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(':')) return null;

  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const tail = value.slice(separator + 1);
    if (isIP(tail) !== 4) return null;
    const octets = tail.split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = value.slice(0, separator + 1) + high + ':' + low;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseWords = (part) => part ? part.split(':').map((word) => {
    if (!/^[a-f0-9]{1,4}$/.test(word)) return NaN;
    return Number.parseInt(word, 16);
  }) : [];
  const left = parseWords(halves[0]);
  const right = halves.length === 2 ? parseWords(halves[1]) : [];
  if ([...left, ...right].some((word) => !Number.isInteger(word))) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

/**
 * Return true for IP addresses that should not be treated as public Internet
 * destinations. This is a deliberately conservative SSRF policy, not a claim
 * that every address outside these ranges is reachable from every network.
 * Callers should separately reject local hostnames and pin vetted DNS answers.
 */
export function isNonPublicIpAddress(address) {
  const version = isIP(String(address || '').replace(/^\[|\]$/g, ''));
  if (version === 4) return isNonPublicIPv4(String(address).replace(/^\[|\]$/g, ''));
  if (version !== 6) return false;

  const words = parseIPv6(address);
  if (!words) return true;

  // IPv4-mapped IPv6 must inherit the IPv4 policy rather than bypass it.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const octets = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255];
    return isNonPublicIPv4(octets.join('.'));
  }

  // Unspecified, loopback, and deprecated IPv4-compatible forms.
  if (words.slice(0, 6).every((word) => word === 0)) return true;

  // Unique-local, all FE00::/8 reserved/link-scoped/site-local space, and multicast.
  if ((words[0] >= 0xfc00 && words[0] <= 0xfdff) ||
      (words[0] >= 0xfe00 && words[0] <= 0xfeff) ||
      words[0] >= 0xff00) return true;

  // Only 2000::/3 is assigned for IPv6 unicast global addressing. This also
  // blocks the IPv6 discard-only, dummy, and SRv6 special-purpose ranges outside it.
  if (words[0] < 0x2000 || words[0] > 0x3fff) return true;

  // Conservative blocks for special-purpose/transition ranges that sit inside
  // global-unicast space. Keep the broad legacy exclusions for compatibility.
  if (words[0] === 0x2001 &&
      ([0x0000, 0x0001, 0x0002, 0x0003, 0x0010, 0x0020, 0x0db8].includes(words[1]) ||
       (words[1] === 0x0004 && words[2] === 0x0112))) return true;
  if (words[0] === 0x2002 || words[0] === 0x3fff) return true;

  return false;
}
