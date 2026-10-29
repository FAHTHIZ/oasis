Harden `loadMcpServers()` in `src/mcp.mjs` against oversized and ambiguous configuration files.

Requirements:
- Reject an MCP configuration file larger than 1 MiB before parsing it.
- Reject configurations with more than 40 server entries.
- Reject duplicate server names after validating the entries.
- Preserve existing per-server validation and the behavior where a missing configuration file returns an empty server list.
- Add focused tests or equivalent deterministic verification for all three rejection cases.
