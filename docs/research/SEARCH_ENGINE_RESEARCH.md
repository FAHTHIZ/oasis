> **Supporting research:** this records design rationale and prior-art review. It is not a user guide or a claim that every proposed search capability is shipped. Current capabilities are described in [the project plan](../PROJECT_PLAN.md) and [user guide](../USER_GUIDE.md).

# OASIS search-engine research

## Decision and baseline

The existing OASIS web search is implemented in src/web-search.mjs. Before federation, each search used one backend: Tavily if TAVILY_API_KEY was present, otherwise Brave if BRAVE_SEARCH_API_KEY was present, otherwise a configured SearXNG JSON endpoint (OASIS_SEARXNG_URL), otherwise DuckDuckGo HTML parsing. OASIS also has a multi-angle /deep-research workflow in src/workflows/deep-research.js that plans search angles, reads sources, cross-checks claims, and returns a cited report.

The new layer keeps the existing web_search interface and legacy provider precedence, but can query configured providers in parallel, deduplicate URLs, merge ranks with Reciprocal Rank Fusion (RRF), apply local domain filters, expose provider errors without leaking credentials, and fall back to DuckDuckGo if configured engines return no results. At least two configured sources are needed to test the main benefit of federation.

## Prior-art comparison

| Project | What it contributes | Decision |
| --- | --- | --- |
| [SearXNG](https://github.com/searxng/searxng) | Mature self-hosted metasearch aggregation, privacy orientation, configurable engines; AGPL-3.0 | Support its JSON API as an optional user-operated backend rather than embedding/forking it in this Node project. |
| [Exa MCP Server](https://github.com/exa-labs/exa-mcp-server) | Semantic web search, clean content retrieval, optional multi-step research tools | Add a native Exa API adapter; credential is EXA_API_KEY. |
| [Tavily MCP](https://github.com/tavily-ai/tavily-mcp) | Search plus extract, map and crawl; supports local and remote MCP setups | Keep the existing Tavily adapter and route. |
| [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server) | General web and specialized search through a maintained API/MCP integration | Keep existing Brave support and include it in federation. |
| [scout](https://github.com/shidoyu/scout) | MIT-licensed Claude Code research plugin: query refinement, primary-source routing, optional Context7/Exa/Jina, privacy-aware local browser fetching, and a visible research trail | Adopt its query-design, domain-routing, privacy, and trail ideas; OASIS adds provider fusion and an inspectable baseline benchmark. |
| [Liner Claude Plugin](https://github.com/liner-engineering/liner-claude-plugin) | OAuth-backed remote MCP with web and scholar search plus search/deep-research agents | Useful hosted alternative and scholarly-source pattern; keep OASIS's core portable and provider-neutral rather than requiring a Liner account. |
| [claude-code-kit](https://github.com/jblenman/claude-code-kit) | Modular Claude Code marketplace including paced web research, claim verification, and request guards | Adopt explicit pacing, bounded research, claim-by-claim verification, and rollback-friendly plugin packaging. |
| [web-search-plus-mcp](https://github.com/robbyczgw-cla/web-search-plus-mcp) | Multi-provider routing, fallback behavior, provider-aware research and result fusion | Adopt the architectural patterns independently; do not copy its source. |
| [web-retrieval-mcp](https://github.com/VelvetSP/web-retrieval-mcp) | Source-separated output, explicit retrieval provenance, resilient fetching, developer and paper search | Use explicit source/provider metadata and observable failure handling. |
| [open-websearch-mcp](https://github.com/atinseau/open-websearch-mcp) | Browser-rendered page extraction and investigation state without a search API | Useful design ideas, but its documented Apple Silicon/macOS + Bun requirements make it unsuitable as OASIS's cross-platform Node baseline. |

## Architecture

- Search adapters: Tavily, Brave, SearXNG, Exa, and Firecrawl. DuckDuckGo HTML remains the keyless fallback.
- Routing: auto uses a single configured source when only one is configured; it federates when multiple are available. single deliberately uses one preferred source. federated tries each configured source.
- Fusion: URL canonicalization strips common tracking parameters and fragments; reciprocal-rank fusion rewards results found near the top of more than one source.
- Source safety: result snippets are untrusted. Fetching is routed through OASIS's bounded public-URL fetcher, with private/reserved addresses blocked, DNS answers pinned, redirects not automatically followed, and response sizes limited.
- Local operation: OASIS and the MCP server run locally; online search providers still require internet access. SearXNG can be hosted on the user's own machine/server, but this work does not create an independent full-web crawler or index.
- Independent-index requirement: provider federation is only a discovery baseline. The product target still requires OASIS-owned crawling, durable document storage, an inverted index, ranking, freshness updates, and reproducible relevance evaluation.
- Onion/Tor boundary: .onion access is not implemented by the current public-URL fetcher. See [FUTURE_DESIGNS.md#tor-onion-access](FUTURE_DESIGNS.md#tor-onion-access) for a fail-closed, Tor-SOCKS-only design. Tor transport is separate from search and must not leak onion URLs or content to public search providers.
- Credentials: API keys belong in environment variables, never in project files, command-line arguments, source control, or chat messages.

## Provider configuration

Set any combination of the following variables in the environment inherited by OASIS or Claude Code:

| Variable | Provider | Purpose |
| --- | --- | --- |
| TAVILY_API_KEY | Tavily | AI-oriented web search |
| BRAVE_SEARCH_API_KEY | Brave | General web search |
| EXA_API_KEY | Exa | Semantic web search and highlights |
| FIRECRAWL_API_KEY | Firecrawl | Web search with extraction-oriented output |
| OASIS_SEARXNG_URL | SearXNG | Self-hosted URL whose /search?format=json endpoint is enabled |
| OASIS_SEARCH_STRATEGY | OASIS | Default strategy: auto, single, or federated |
| OASIS_WEB_SEARCH=off | OASIS | Disable the built-in web_search tool |

Provider queries can incur usage or costs. Auto federation runs multiple provider requests when multiple backends are configured; configure only services whose terms, quotas, and privacy characteristics you accept. Provider failures and rate limits remain visible in results.

## Claude Code plugin

This repository includes a local plugin under plugins/oasis-research. It exposes three read-only MCP tools:

- oasis_web_search: search with auto, single, or federated routing.
- oasis_fetch_url: fetch bounded public text while blocking local/private destinations and redirects.
- oasis_search_status: list configured provider names without revealing credentials.

From the repository root on a machine with Node.js 22+ and Claude Code installed, launch:

    claude --plugin-dir ./plugins/oasis-research

Configure provider keys in the environment that launches Claude Code. Do not put secrets into .mcp.json or the plugin manifest. The included deep-research skill and research command instruct the agent to seek primary sources, read pages, check conflicting evidence, and cite actual URLs. The plugin uses OASIS's shared search and safe fetch modules rather than a separate copy of the engine.

## Benchmark the current and candidate engines

Run from the repository root:

    npm run bench:search

Optional JSON report:

    node scripts/bench-web-search.mjs --out evals/search/reports/local.json

The runner executes the same fixed query set against webSearchLegacy (baseline provider selection) and federated webSearch (candidate). It records expected-domain hit rate, mean reciprocal rank, result counts, unique domains, latency, provider failures, and per-query deltas. These fixtures measure retrieval coverage, not full answer correctness.

For a meaningful multi-engine comparison, configure at least two providers. With zero keys the two sides can both hit DuckDuckGo; with only one provider the candidate cannot demonstrate source diversity. A live run can spend API credits. Repeat runs and inspect failed queries and source quality before replacing the default strategy. Do not claim the system is better based on a single run or just more results.

## Current limits and next steps

- This adds federated API search, not an independent crawler/index of the entire Internet.
- Provider schemas and limits can change; keep adapter tests and run the benchmark after upgrades.
- Result ranking is deterministic RRF without a learned relevance model. A later stage can evaluate cross-encoder reranking against reviewed judgments.
- A standalone self-hosted SearXNG deployment is optional and separate from the Node app.
- Grow the benchmark with negative cases, stale results, and deeper source-quality judgments.
