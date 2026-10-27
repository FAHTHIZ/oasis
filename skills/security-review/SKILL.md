---
name: security-review
description: Review application changes for exploitable trust-boundary, credential, dependency, and data-loss risks.
---

# Security review skill

1. Identify assets, trust boundaries, attacker-controlled inputs, privileged operations, and the impact of compromise before reviewing details.
2. Trace input from source to sensitive sink: process execution, filesystem paths, network requests, HTML rendering, deserialization, logs, and credentials.
3. Check authentication, authorization, session/token lifetime, origin validation, replay behavior, rate limits, and whether secrets can leak through URLs or errors.
4. Inspect dependency additions, install scripts, remote downloads, package lifecycle hooks, permissions, and supply-chain assumptions.
5. Check path traversal, symlink handling, unsafe redirects, SSRF/private-network access, command injection, resource exhaustion, and accidental data deletion.
6. Prioritize findings by concrete impact and realistic exploitability. Cite the exact file and relevant code; separate verified issues from assumptions.
7. Prefer a minimal regression test for each confirmed vulnerability. Do not claim a security audit is comprehensive if only a subset of the system was inspected.
8. Do not weaken authentication, approval, sandboxing, or validation merely to make a demo pass.