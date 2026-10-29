# OASIS Onion Access — Architecture and Safety Contract

## Status

**Design specification only — not implemented yet.** OASIS currently fetches public HTTP/HTTPS URLs directly and blocks local/private destinations. It does not currently connect to Tor or fetch `.onion` addresses. Do not describe onion access as working until code, tests, and CI prove it.

## What this feature means

OASIS should be able to optionally read a user-supplied onion URL through a Tor SOCKS proxy, while keeping the normal public-web fetcher and independent search/index architecture separate. Tor is a transport/network path; it is not a search engine and it does not provide OASIS with an index of onion sites. Onion services are reachable only through Tor (Tor Project documentation: https://support.torproject.org/about-tor/onion-services/what-is-a-dot-onion/).

## Proposed boundaries

- **Transport:** a dedicated onion transport adapter connects only to a configured local Tor SOCKS endpoint. It must use remote hostname resolution through SOCKS; never attempt ordinary DNS resolution of a `.onion` name.
- **Target allowlist:** accept only valid v3 onion hostnames under `.onion`, with HTTP/HTTPS schemes and no embedded credentials. Reject IP literals, ordinary hostnames, malformed onion names, and alternate schemes in this adapter.
- **Proxy configuration:** explicit opt-in via an environment/config setting; never silently route all traffic through Tor. The adapter must fail closed when the proxy is unavailable. Never fall back to direct connections for an onion URL.
- **Isolation:** never send an onion URL or its content to Tavily, Brave, Exa, Firecrawl, SearXNG, analytics, telemetry, or other third-party services. Do not silently follow redirects from an onion host to the public web or vice versa.
- **Resource limits:** bounded request time, response bytes, redirects (prefer none in the first version), content types, and concurrent requests. Keep credentials and cookies out of logs and tool output.
- **Crawling:** onion crawling is disabled by default. Initial access is explicit URL fetch only; any later crawler must require user-selected seeds, strict page/depth budgets, per-host pacing, and a separate index namespace from the clearnet index.
- **User safety:** display a clear notice that Tor transport does not guarantee anonymity of the whole OASIS process, model provider, operating system, or other network traffic. Avoid claims of being “anonymous” or “untraceable.” Users remain responsible for legality and site safety.

## Implementation sequence

1. Add a transport interface so public HTTP(S) and Tor-routed onion requests cannot accidentally share unsafe assumptions.
2. Implement SOCKS5 remote-DNS connection handling for onion-only targets, with certificate validation for HTTPS and strict time/size limits.
3. Add unit tests for v3 hostname validation, proxy failure, no direct fallback, redirect rejection, and no ordinary DNS lookup for onion hostnames.
4. Add an explicit read-only MCP tool such as `oasis_fetch_onion_url`; do not expose it as a generic proxy for arbitrary destinations.
5. Add a local integration test that runs only when a developer explicitly provides a Tor SOCKS endpoint. Never make CI depend on a live onion service.
6. Only after the fetch path is verified, consider a user-seeded, opt-in onion index. Do not imply that it can search “the entire dark web.”

## Relationship to OASIS Search

OASIS's goal remains its own crawler, persistent index, lexical/semantic retrieval, and ranking/evaluation. Third-party web search providers are optional baselines, not the core index. Onion URLs form a separate, explicitly opt-in corpus and must not be sent to external providers.

## Reference

- Tor Project, “What is a .onion?”: https://support.torproject.org/about-tor/onion-services/what-is-a-dot-onion/
