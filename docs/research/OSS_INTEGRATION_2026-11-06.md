# Open-source integration program — 2026-11-06

Direction from the owner: research the open-source ecosystem first and adopt
proven community components instead of maintaining hand-written equivalents,
where the component is technically stronger. This file is the running record
for that program: evidence, decisions, completed integrations, measurements
and next priorities. Update it after every integration.

## Starting point

OASIS was built "dependency-free": three runtime dependencies (xterm, its fit
addon, quickjs-emscripten) and ~63k lines of hand-written modules, including
its own shell tokenizer, regex repo map, MCP client, JSON-Schema validator,
YAML front-matter reader, HTML-to-Markdown converter, PDF and ZIP readers.
Baseline full suite on Node 22.23.4 at `e0f3c7c`-era main: 1975 tests,
1966 pass, 0 fail, 9 skipped. CI main was red on one racy gateway test
(`test/bench-gateway.test.mjs`, fixed in this program's first commit).

## What competing harnesses actually depend on (verified from manifests)

Read directly from each project's manifest on 2026-11-06:

| Concern | Gemini CLI (core) | Codex (codex-rs) | Roo Code | Cline SDK | OpenCode | Aider | OASIS before |
|---|---|---|---|---|---|---|---|
| Shell command parsing | web-tree-sitter + tree-sitter-bash, shell-quote | tree-sitter + tree-sitter-bash (+ PowerShell) | shell-quote | — | tree-sitter-bash wasm | oslex | hand tokenizer |
| Code structure / repo map | — | — | web-tree-sitter + tree-sitter-wasms | — | tree-sitter | grep_ast (tree-sitter) + networkx PageRank | regex + PageRank |
| MCP client | @modelcontextprotocol/sdk | rmcp (official Rust SDK) | @modelcontextprotocol/sdk | @modelcontextprotocol/sdk | official SDK | — | hand-written |
| JSON Schema | ajv, zod | — | zod | zod | zod | jsonschema | hand-written |
| YAML | js-yaml | — | yaml / js-yaml | yaml | — | PyYAML | hand-written subset |
| Diffs | diff | similar | diff | — | diff | diff-match-patch | hand-written |
| HTML → text | html-to-text | — | turndown, cheerio | — | turndown | beautifulsoup4, pypandoc | hand-written |
| Search | ripgrep (@joshua.litt/get-ripgrep) | ripgrep crates | ripgrep | — | ripgrep | — | ripgrep when on PATH, JS fallback |
| Sandbox | seatbelt profiles, containers | landlock + seccomp, seatbelt | — | — | — | — | bwrap / sandbox-exec adapters |

Claude Code is closed source, but Anthropic publishes its sandbox as
`@anthropic-ai/sandbox-runtime` (Apache-2.0) and documents that its Bash tool
parses commands and fails closed on what it cannot parse.

Package facts (npm registry, 2026-11-06): web-tree-sitter 0.27.1 MIT, ~8.5M
weekly downloads; @vscode/tree-sitter-wasm 0.3.1 MIT (Microsoft, used by VS
Code; ships the runtime and bash, PowerShell, TypeScript/TSX, JavaScript,
Python, Go, Rust, Java, C#, C++, Ruby, PHP, CSS, INI, regex grammars);
@modelcontextprotocol/sdk 1.32.2 MIT, ~88M weekly; ajv 8.20.0 MIT;
yaml 2.9.1 ISC, zero deps; turndown 7.2.5 MIT; @mozilla/readability 0.6.0
Apache-2.0; linkedom 0.18.15 ISC; diff 9.0.0 BSD-3; @vscode/ripgrep 1.18.0
MIT; @anthropic-ai/sandbox-runtime 0.0.81 Apache-2.0 (pre-1.0).

Research on context management: Lindenbauer et al., "The Complexity Trap:
Simple Observation Masking Is as Efficient as LLM Summarization for Agent
Context Management" (JetBrains Research, NeurIPS 2025 DL4Code workshop,
arXiv 2508.21433) found that replacing old tool observations with a
placeholder roughly halves cost relative to an unmanaged agent and matches or
beats LLM summarization on SWE-bench Verified.

## Integration queue (highest value first)

1. **Shell analysis on tree-sitter-bash** — security; every major harness
   does it. DONE (see below).
2. **Permission-rule and read-only matching on the same AST** — remove the
   other two hand splitters so allow rules, auto-approval and risk analysis
   can never disagree about where a command starts.
3. **Repo map on tree-sitter tags** (same runtime, grammars already bundled)
   with regex fallback for languages the bundle lacks.
4. **Official MCP SDK** for client transports (stdio, Streamable HTTP, legacy
   SSE, OAuth), keeping OASIS trust pinning and tool-surface hashing on top.
5. **ajv** for tool-argument and MCP schema validation; **yaml** for skill,
   agent and plugin front matter.
6. **Readability + linkedom + turndown** for web fetch.
7. **@vscode/ripgrep** so search is always ripgrep-backed.
8. **Observation masking** tuned to keep prompt-cache prefixes stable,
   measured with `bench/tokens`.
9. Evaluate `@anthropic-ai/sandbox-runtime` for domain-filtered network
   access inside the sandbox once it reaches a stable API.

## Completed

### 1. Shell analysis on tree-sitter-bash

`src/shell-ast.mjs` loads the bash grammar from `@vscode/tree-sitter-wasm`
and turns the syntax tree into the `{ tokens, pipedFrom }` commands the
existing risk rules already understand, so the rules stay and only the
splitter changes. Bash lines use the AST; PowerShell/cmd lines (drive
letters, `$env:`, Verb-Noun cmdlets) keep the legacy splitter. If the grammar
is missing or still loading, the legacy splitter is used, and `run_shell`
awaits the grammar before checking a command.

Evidence: an adversarial probe of the legacy analyzer returned "no risk" for
`$'\x72\x6d' -rf ~`, `$'rm' -rf ~`, `sh -s <<< 'rm -rf ~'`,
`bash <<< "rm -rf ~"`, `f(){ rm -rf ~; }; f`, `case x in x) rm -rf ~;; esac`,
`for d in ~; do rm -rf "$d"; done` and `eval "$(printf 'rm -rf ~')"`, and
blocked the harmless `echo hi # ; rm -rf ~`. With the AST, every one of the
destructive lines is blocked (or needs a person, for run-time computed
programs and eval text) and the comment is allowed. Lines the grammar cannot
parse now fail closed to "needs a person". Pinned in
`test/shell-ast.test.mjs`; the 221 existing shell and run_shell tests pass
unchanged with the grammar preloaded.

### 1b. Deny and ask rules on the same AST

A `Bash(git push:*)` deny rule did not match `f(){ git push; }; f`,
`case a in a) git push;; esac`, `bash <<< 'git push'` or `x=git; $x push`
with the legacy permission splitter. Deny/ask matching now also checks every
command the grammar finds (function bodies, case arms, loops, scripts fed to
a shell, programs named through a variable set earlier on the line), as a
union with the legacy pieces, so denial only broadens. Allow rules keep the
strict legacy requirement. `authorizeCall` awaits the grammar before
evaluating any shell call.

Verification: full suite on Node 22.23.4 — 1983 tests, 1974 pass, 0 fail
(9 skipped, same as baseline) before the permission change; the 182 shell,
permission and hook tests pass after it; `npm run check:quick`,
`eval --validate` (52/52) and `eval --negative-control` pass; token budgets
unchanged (`bench/tokens --check`).
