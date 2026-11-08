// SSRF address policy shared by web fetch, the browser tool, plugin downloads and
// MCP OAuth. Address parsing is done by ipaddr.js (MIT; the parser behind
// Express's proxy-addr), so every IPv4/IPv6 spelling, including compressed,
// zone-scoped and IPv4-embedded forms, is normalised by one well-tested library.
// The policy itself is a declarative CIDR table below.
import ipaddr from 'ipaddr.js';

// IPv4 destinations that are never treated as the public Internet
// (IANA IPv4 Special-Purpose Address Registry plus conservative extras).
const NON_PUBLIC_IPV4 = [
  '0.0.0.0/8',          // "this" network
  '10.0.0.0/8',         // private
  '100.64.0.0/10',      // carrier-grade NAT (also Tailscale)
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local, cloud metadata
  '172.16.0.0/12',      // private
  '192.0.0.0/24',       // IETF protocol assignments
  '192.0.2.0/24',       // TEST-NET-1
  '192.88.99.0/24',     // deprecated 6to4 relay anycast
  '192.168.0.0/16',     // private
  '198.18.0.0/15',      // benchmarking
  '198.51.100.0/24',    // TEST-NET-2
  '203.0.113.0/24',     // TEST-NET-3
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4'         // reserved and limited broadcast
].map((cidr) => ipaddr.parseCIDR(cidr));

// IPv6 destinations that are never public. Anything outside 2000::/3 is also
// rejected because only that block is allocated for global unicast.
const NON_PUBLIC_IPV6 = [
  '64:ff9b:1::/48',     // local-use NAT64
  '2001::/23',          // IETF protocol assignments (Teredo, ORCHID, benchmarking...)
  '2001:db8::/32',      // documentation
  '2001:4:112::/48',    // AS112-v6
  '2002::/16',          // 6to4
  '3fff::/16',          // documentation (RFC 9637)
  'fc00::/7',           // unique local
  'fe00::/8',           // link-local and reserved scopes
  'ff00::/8'            // multicast
].map((cidr) => ipaddr.parseCIDR(cidr));
const GLOBAL_UNICAST = ipaddr.parseCIDR('2000::/3');
const NAT64_WELL_KNOWN = ipaddr.parseCIDR('64:ff9b::/96');

function inAny(address, ranges) {
  return ranges.some((range) => address.match(range));
}

function isNonPublicIPv4(address) {
  return inAny(address, NON_PUBLIC_IPV4);
}

function embeddedIPv4(address) {
  const bytes = address.toByteArray();
  return new ipaddr.IPv4(bytes.slice(12));
}

function parse(raw) {
  let value = String(raw || '').trim().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  // Strict forms only: ipaddr.isValid accepts legacy inet_aton spellings such as
  // "0x7f.1" or "2130706433"; those are not IP literals for this policy.
  if (ipaddr.IPv4.isValidFourPartDecimal(value)) return ipaddr.IPv4.parse(value);
  if (!value.includes(':')) return null;
  // ipaddr.js reads "::a.b.c.d" (deprecated IPv4-compatible) as "::ffff:a.b.c.d"
  // (IPv4-mapped). Rewrite a dotted tail into two hex words first so the two
  // forms stay distinct.
  const dotted = value.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(dotted[2])) return null;
    const [a, b, c, d] = ipaddr.IPv4.parse(dotted[2]).octets;
    value = dotted[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  return ipaddr.IPv6.isValid(value) ? ipaddr.IPv6.parse(value) : null;
}

/**
 * Return true for IP addresses that should not be treated as public Internet
 * destinations. This is a deliberately conservative SSRF policy, not a claim
 * that every address outside these ranges is reachable from every network.
 * Callers should separately reject local hostnames and pin vetted DNS answers.
 * Non-IP input returns false (it is a hostname, not an address); a string that
 * looks like IPv6 but does not parse is treated as non-public.
 */
export function isNonPublicIpAddress(raw) {
  const text = String(raw || '').trim().replace(/^\[|\]$/g, '');
  const address = parse(text);
  if (!address) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) return true; // malformed dotted quad
    return text.includes(':');
  }
  if (address.kind() === 'ipv4') return isNonPublicIPv4(address);

  // IPv4-mapped (::ffff:a.b.c.d) inherits the IPv4 policy rather than bypassing it.
  if (address.isIPv4MappedAddress()) return isNonPublicIPv4(address.toIPv4Address());
  // Well-known NAT64 prefix encodes an IPv4 destination: apply the IPv4 policy.
  if (address.match(NAT64_WELL_KNOWN)) return isNonPublicIPv4(embeddedIPv4(address));
  // ::/96 covers unspecified, loopback and deprecated IPv4-compatible forms.
  const words = address.parts;
  if (words.slice(0, 6).every((word) => word === 0)) return true;
  if (!address.match(GLOBAL_UNICAST)) return true;
  return inAny(address, NON_PUBLIC_IPV6);
}

/** Normalised textual form of an IP literal, or null when the input is not one. */
export function normalizeIpAddress(raw) {
  const address = parse(raw);
  return address ? address.toNormalizedString() : null;
}
