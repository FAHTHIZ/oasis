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

### 2. Repo map on tree-sitter

`src/code-ast.mjs` runs definition queries (written per grammar, capturing
`@name`/`@def`) for JavaScript, TypeScript/TSX, Python, Go, Rust, Java, C#,
C/C++ (C++ grammar), Ruby, PHP and bash, skips definitions nested inside
functions, and blanks comments and string literals (one native query per
grammar) before identifier counting. Other languages keep the regex patterns.
`src/tree-sitter.mjs` owns the single runtime: a first version initialised
the runtime separately in the shell and code modules, and in 2 of 3 runs all
Python grammar loads failed because two `Parser.init` calls raced; one
single-flight loader fixed it (5/5 clean runs).

Quality, measured against compiler ground truth (`/tmp/eval` scripts:
Python `ast` for requests, flask, httpx; TypeScript compiler API for ky and
zod), definitions matched by name and line:

| Corpus | Extractor | Precision | Recall | F1 |
|---|---|---|---|---|
| Python, 180 files, 2,793 defs | regex | 80.7% | 94.4% | 87.0 |
| | tree-sitter | 100.0% | 100.0% | 100.0 |
| TypeScript, 363 files, 3,082 defs | regex | 84.7% | 88.1% | 86.4 |
| | tree-sitter | 95.6% | 97.9% | 96.7 |

Latency, full `buildRepoMap` on OASIS (836 files, 7.9 MB JS): regex 757 ms
cold per process; tree-sitter 3.9 s on the very first scan (parsing ~1.8 s,
queries ~1.1 s), 0.30 s in any later process thanks to the new on-disk scan
cache (mtime+size keyed, versioned by grammar package and extractor; 2.9 MB
for OASIS). Warm in-process maps are ~0.2 s either way.

Full suite after this change: 1988 tests, 1979 pass, 0 fail, 9 skipped.

### 3. MCP client on the official SDK

Deleted: the hand-written stdio JSON-RPC client (`src/mcp.mjs`), the
Streamable HTTP and SSE parsers (`src/mcp-project.mjs`), and OAuth discovery,
registration, PKCE, exchange and refresh (`src/mcp-oauth.mjs`). Replaced with
`@modelcontextprotocol/client` 2.4.0 (Apache-2.0; deps zod 4, jose,
cross-spawn, eventsource, pkce-challenge). OASIS keeps: the token store,
HTTPS-only/DNS-pinned OAuth fetch (`createOAuthFetch`), the 4 MiB response
cap, process-group stdio spawning with a filtered environment, tool pinning,
roots/elicitation/channels handlers.

Measured with the official conformance suite
(github.com/modelcontextprotocol/conformance, 21 client scenarios, spec
2025-11-25), `scripts/mcp-conformance/run.sh`:

| Client | Non-auth (4) | Auth (17) | Warnings |
|---|---|---|---|
| Old hand-written | 2 (failed elicitation defaults, SSE retry) | ~0 as shipped (localhost AS refused); with the loopback rule relaxed, 6 hard failures + 3 warnings | - |
| SDK-backed OASIS | 4 | 17 | 0 |

Failures the old client had with the loopback rule relaxed: resource
identifier normalisation, path-based AS discovery, scope step-up,
`client_secret_basic` (2 scenarios), scope from `WWW-Authenticate`, CIMD.

Costs: the SDK import is ~110 ms, paid only when a server connects. It first
landed inside `createSession` in non-blocking mode (session start 108 ms ->
~240 ms, which failed `mcp-nonblocking` under load); background connection
now starts after `createSession` returns (back to ~108 ms). The SDK is
stricter than the old client: `initialize` must carry `serverInfo`, and AS
metadata must list `response_types_supported` (RFC 8414); test fixtures were
updated to the spec.

### 4. Parsers: yaml, smol-toml, jsonc-parser, Ajv, jsonrepair

Deleted: ~15 regex front-matter parsers (subagents, memory rules, auto-memory,
importers x4, skills, extensions, app server, tools), `parseYamlSubset`
(~80 lines), the TOML parser (~105 lines), the JSONC stripper, the JSON Schema
walker (`src/json-schema.mjs`) and the character-level JSON repair
(`repairStructure`, `closeBrackets`). `src/` net change: -438/+228 lines.

| Library | Version | Licence | Runtime deps |
|---|---|---|---|
| yaml (eemeli) | 2.9.1 | ISC | 0 |
| smol-toml | 1.9.1 | BSD-3-Clause | 0 |
| jsonc-parser (Microsoft) | 3.3.1 | MIT | 0 |
| ajv | 8.20.0 | MIT | 4 (fast-deep-equal, fast-uri, json-schema-traverse, require-from-string) |
| jsonrepair | 3.15.0 | ISC | 0 |

Bugs the old code had, now covered by `test/oss-parsers.test.mjs`: the JSONC
trailing-comma regex rewrote `",}"` inside strings; the front-matter parsers
dropped block scalars, lists and nested maps (agent `hooks:` read as `''`);
the TOML parser lacked arrays of tables and multi-line strings; the schema
checker ignored `$ref`, `anyOf` and `oneOf`.

Decisions: front matter uses YAML's failsafe schema so scalars stay strings
(`version: 1.0` stays `'1.0'`, as before); config files use the core schema.
When strict YAML fails, top-level plain values are quoted and parsed again,
because Claude Code-style front matter such as `description: Use when: ...`
or Cursor's `globs: **/*.ts` is invalid YAML yet common. jsonrepair would
close a string cut off mid-value; OASIS refuses those calls, as before, so a
truncated `content` is never written. The old stray-brace retry loop was
removed: jsonrepair drops a redundant `}` itself, and keeping the loop let
garbage like `"x" "oops"` through.

The browser app imports two of these modules (`tool-call-repair`,
`frontmatter`); it now gets `yaml` and `jsonrepair` through an import map
(hash in the CSP) and a `/vendor/` route limited to `APP_PACKAGES`' browser
build folders. Both e2e suites (`app-e2e`, `app-runtime-e2e`) caught the
missing route before it shipped.

Not replaced: `validateElicitationContent` turns typed terminal answers into
values (enum by index, yes/no); that is interface logic, not schema validation.

### 5. fetch_url HTML: entities adopted, Readability + Turndown measured and rejected

Candidates were measured on 10 real pages (MDN Array.map, Wikipedia Rust, Node
fs docs, GitHub MCP SDK README, Python asyncio docs, Rust blog index, Hacker
News, Anthropic engineering post, react.dev useState, Effective Go). The
harness is `/tmp/htmleval/eval.mjs`: OASIS `htmlToMarkdown` against
`@mozilla/readability` 0.6.0 + `turndown` 7.2.5 + `@joplin/turndown-plugin-gfm`
1.0.68 on `linkedom` 0.18.15.

| Page | OASIS chars / ms | Readability+Turndown chars / ms |
|---|---|---|
| MDN Array.map | 11,664 / 34 | 11,222 / 178 |
| Wikipedia Rust | 129,580 / 190 | 178,038 / 806 (stops at "In academic research"; drops governance, see also and references; citation links inline) |
| Node fs | 392,326 / 234 | 397,291 / 1,360 |
| Hacker News | 13,187 / 6 | 38 / 37 (Readability finds no article) |
| Anthropic post | 51,425 / 299 | 41,313 / 164 (title and lede lost; links left relative) |
| Effective Go | 101,826 / 35 | 101,181 / 58 |

Readability+Turndown also rendered a Rust `#[unsafe(no_mangle)]` code line as
a heading. Domino (Turndown's own DOM) failed with Readability ("nodeList is
not iterable"). Verdict: the OASIS converter is a Readability port with
link-index and short-extraction fallbacks, and is better on this set; kept.

What was replaced: the hand-written entity table (about 150 of 2,231 HTML5
names, plus a semicolon-optional regex that corrupted `&copy=` in URLs) with
`entities` 9.0.0 (`decodeHTML`, `decodeHTMLAttribute`), and web search's
five-entity decoder. Output on the 10 pages is byte-identical; timing is
unchanged (fs docs 184–282 ms old, 192–278 ms new). The browser app gets
`entities` through the import map.

### 6. Bundled ripgrep

`@vscode/ripgrep` 1.18.0 (MIT): per-platform optional packages
(`@vscode/ripgrep-<os>-<arch>`, 5.5 MB on linux-x64), no postinstall
download. The package's own entry point throws on platforms without a
binary, so `src/ripgrep.mjs` resolves the platform package directly.
Measured on this repository (1,238 tracked files) with PATH empty, count
mode: `createSession` 190 ms (ripgrep) against 8,750 ms (built-in), and
`TODO|FIXME` 76 ms against 8,189 ms. File counts agreed (145/145; 18/17,
because the built-in search stops at 8,000 files and does not read
`.gitignore`).

### 7. PDF text: unpdf (pdf.js) replaces the built-in extractor

Harness: `/tmp/unpdfenv/eval.mjs`. Reference is `pdftotext -enc UTF-8`;
recall counts distinct lowercase words of four or more letters from the reference that
appear in the candidate.

| PDF | pages | built-in recall / ms | unpdf 2.1.0 recall / ms |
|---|---|---|---|
| arXiv 2508.21433 | 31 | 98.4% / 68 | 99.0% / 328 |
| arXiv 1706.03762 | 15 | 97.1% / 140 | 99.0% / 572 |
| IRS fw4.pdf | 5 | 90.3% / 57 | 100.0% / 101 |
| W3C pdf-table example | 1 | 100.0% / 9 (table emitted twice, spurious page breaks) | 100.0% / 124 |
| pdfobject sample | 1 | 99.2% / 5 | 100.0% / 24 |

pdf.js is slower but correct, and it splits pages by the page tree rather
than by counting content streams, so page ranges work without poppler.
`pdftotext` stays first when it is installed. unpdf is 3.2 MB unpacked, has no
dependencies and is imported lazily.

### 8. Browser app zip: fflate

`app/core/zip.mjs` wrote stored entries with its own CRC table and read
archives without bounds checks. It is now a wrapper around `fflate` 0.8.3:
deflate export (checked with `unzip -t`), ZIP64 import, and clear errors for damaged input. fflate does
not verify CRCs on unzip; neither did the old reader. `src/zip.mjs` (CLI
plugin archives) is kept: it rejects symlinks using external attributes,
duplicate and case-colliding paths, and Windows-reserved names, and fflate's
unzip filter does not expose the external attributes needed for the symlink check.

### 9. Diffs: jsdiff

Replaced: `lineDiff` in `src/markdown.mjs` (O(n×m) LCS table, all-or-nothing
past 250,000 cells), `lineDiff` in `app/core/workspace.mjs` (same algorithm
after trimming the common prefix and suffix), `unified()` in
`app/core/tools.mjs` (one hunk, headers without counts) and `renderPlainDiff`
in `src/ast-grep.mjs` (bare `@@` separators). All now use `diff` 9.0.0:
`diffArrays` with `maxEditLength: 5000, timeout: 250` for previews, and
`createTwoFilesPatch` with `FILE_HEADERS_ONLY` for patches. Measured:
5,000 lines with two edits diffs in 1.4 ms; the worst case (every line
different, 5,000 lines) stops at the 250 ms bound (measured 256 ms) and falls back to a full replacement.
A regression test against the old code confirms that the 600-line case failed before
and passes now. The patch the browser app's edit tool returns is checked with
`applyPatch`.

### 10. Decision: read-only command classifier stays on the string splitter

`readOnlyShellLine` (auto-approval of read-only shell lines) refuses any line
containing `$`, backticks, `<`, `>` (beyond the harmless redirects it strips),
parentheses, braces, newlines or a lone `&` before it splits. What remains is
words, quotes and the `;`, `&&`, `||` and `|` separators, where the splitter
and bash agree. The places where they could disagree (ANSI-C quoting,
substitutions, heredocs, subshells, functions) are already refused, and a
`#` comment only makes the check stricter. Moving it to the tree-sitter AST
would add no safety and adds an asynchronous dependency to an
approval path; risk analysis (`shell-risk.mjs`) already uses the AST.

### 11. Observation masking (measured; opt-in)

Source: Lindenbauer et al., "The Complexity Trap: Simple Observation Masking
Is as Efficient as LLM Summarization for Agent Context Management" (JetBrains
Research, arXiv 2508.21433): keep the last M turns' observations, replace
older ones with placeholders. OASIS already had threshold masking
(`microcompact`, triggered at half the context window). This adds a rolling
window, `maskObservations`, with batching to limit prompt-cache invalidation.

`node bench/tokens/run.mjs` (scripted, so the scenarios pass regardless of
what the model sees; numbers are estimates, not provider-reported):

| turns / batch | taskflow input · cache-weighted | normalize input · cache-weighted | normalize last request |
|---|---|---|---|
| off | 156,848 · 26,998 | 261,673 · 44,816 | 20,782 |
| 10 / 4 | 153,193 · 29,818 | 244,068 · 46,304 | 11,979 |
| 6 / 4 | 145,880 · 27,766 | 208,854 · 41,842 | 11,979 |
| 6 / 1 | 140,492 · 35,883 | 196,476 · 65,017 | 10,578 |
| 4 / 4 | 142,222 · 27,067 | 191,245 · 39,563 | 11,978 |

Finding: with prompt caching, per-turn masking (batch 1, as in the paper)
costs more, because every slide changes the cached prefix. Batched masking is
roughly cost-neutral on these short runs and halves the size of late requests,
which is what matters for small local windows. Not measured here: effect on
solve rate (the bench is scripted) and runs longer than 18 requests. Default
stays off until a live A/B (`npm run bench:live`) shows no loss in solve rate.

### 12. Sandbox network allowlists: @anthropic-ai/sandbox-runtime

OASIS's bubblewrap and Seatbelt backends could only turn the network fully on or off. sandbox-runtime
0.0.81 adds domain filtering through an HTTP and SOCKS proxy that lives in the
calling process, reached from inside the network namespace over Unix sockets bridged by
socat. Integrated as a backend (`kind: 'srt'`, `src/sandbox-runtime.mjs`)
selected by `sandbox.allowedDomains`; the existing bubblewrap, Seatbelt,
container and SSH backends are unchanged for on/off networking.

Findings while integrating:
- The proxy runs in the parent's event loop. `spawnSync` deadlocks it (the first
  attempt timed out); OASIS spawns asynchronously everywhere it wraps commands.
- `initialize()` keeps the process alive until `reset()`, so the adapter
  reference-counts holders and resets 200 ms after the last one exits.
- `wrapWithSandboxArgv` returns `/bin/bash -c '<bwrap …>'`, a single argument
  that can exceed 5,000 characters; the PTY manager's per-argument cap was
  raised to 64 KiB.
- Node's built-in `fetch` ignores `HTTPS_PROXY`, so inside the sandbox it fails
  closed (EAI_AGAIN). curl, pip, npm and git honour the proxy.
- A test that ran `curl -o` passed without curl ever starting, because `-o`
  needs approval as high risk. The test now asserts that the command ran.

### 13. File globs: picomatch

Four hand-written glob-to-regex compilers existed: `src/tools.mjs` (glob_files; no braces, no classes), `src/power-tools.mjs` (grep fallback; braces, no classes), `src/permissions.mjs` (permission rules) and `app/core/tools.mjs` (browser app). The first two now use picomatch through `src/glob.mjs`. A regression test (braces, classes, a literal `[id]` folder) fails on the old code and passes now. Kept: the permission matcher, because changing what a deny rule covers is a security change and its behaviour follows Claude Code's rule syntax; and the browser app's matcher, because picomatch is CommonJS-only and cannot load through the import map (minimatch and zeptomatch are ESM but bring dependency chains that would also need vendoring).

## 14. Terminal display width: string-width + strip-ansi

Replaced: `stringWidth`/`charWidth`/`stripAnsi`/`truncateToWidth` hand-written ranges in `src/line-editor.mjs` (used by markdown wrap, tables, Mermaid ASCII, the line editor).
Adopted: `string-width` 8.3.0 and `strip-ansi` 7.2.0 (sindresorhus, MIT; used by Ink, which Claude Code and Gemini CLI render with).

Measured (old → new): 🚀 1→2, ✅ 1→2, 👨‍👩‍👧 6→2, 👍🏽 4→2, हिन्दी 6→4; CJK, Bengali, SGR and OSC-8 equal.
Raw string-width is ~80× slower than the old table, so printable-ASCII strings return `.length`. Markdown render of USER_GUIDE (233 KB): 11 ms before, 14 ms after; mixed-script variant 11 → 8 ms.
Regression test `test/string-width.test.mjs` fails on the old implementation (negative control) and passes now.
Remaining limitation: markdown/Mermaid still iterate code points when hard-breaking single over-long words.

## 15. LSP JSON-RPC transport: vscode-jsonrpc

Replaced: `onData`/`onMessage`/`send` and the manual id/pending map in `LspClient` (`src/lsp.mjs`).
Adopted: `vscode-jsonrpc` 8.2.1 (Microsoft, MIT, 0 dependencies, 352 KB), the transport under vscode-languageclient.
Kept: process lifecycle (process groups, graceful shutdown → SIGTERM → SIGKILL), timeouts and error text, the document sync and diagnostics waiters.
Gains: `$/cancelRequest` on timeout via CancellationTokenSource (verified on the wire: the old transport never sent it), spec-conformant header parsing, and error replies as ResponseError.
Lost: the 64 MiB frame cap (vscode-jsonrpc has no size limit). Language servers are local binaries the user approves, so this is accepted.
Real-server check with typescript-language-server: hover/references/diagnostics/document_symbols outputs are identical to the old transport; first hover takes 309 ms vs 282 ms (server startup), later calls 2–4 ms both.

## 16. HTML parser: parse5 and htmlparser2 evaluated, hand parser kept

Tried: replacing `parseHtml` in `src/html-markdown.mjs` with parse5 8.1.0 (WHATWG tree building) converted to the extractor's tree, and htmlparser2 10.
fetch_url feeds this parser untrusted pages, so worst-case cost decides. Raw parse time for `'<div>'.repeat(n)`:

| n | parse5 | htmlparser2 | OASIS parseHtml |
|---|---|---|---|
| 20,000 | 2,552 ms | 94 ms | — |
| 40,000 | 12,809 ms | 657 ms | 34 ms |
| 100,000 | — | 3,888 ms | 80 ms |
| 200,000 | (aborted after > 2 min) | 14,526 ms | 122 ms |

Both libraries are quadratic in open-element depth (scope checks walk the stack); the OASIS parser caps depth at 256 and stays linear. A 1 MB hostile page would stall fetch_url for minutes with parse5. Kept; libraries rejected on denial-of-service grounds. (Separately, the full conversion of 200k nested divs takes 9.3 s in extraction/rendering, not parsing. Recorded as a follow-up.)

## 17. ACP server: @agentclientprotocol/sdk

Replaced: newline JSON-RPC framing, id/pending bookkeeping, dispatch and error replies in `src/acp.mjs` (`send`/`request`/`receive`, readline loop).
Adopted: `@agentclientprotocol/sdk` 2.4.0 (Zed Industries, Apache-2.0; the reference SDK, the successor to `@zed-industries/agent-client-protocol`, which is deprecated). Adds 9 MB; its peer `zod` 4 was already installed via the MCP client.
Kept: all OASIS session logic (openSession, prompt streaming, permission mapping, client fs, editor terminals, diffs) behind `handle(method, params)`.
Behaviour changes, all spec-aligned: requests before `initialize` → -32600; invalid params → -32602 with zod field errors (previously reached handlers); 32 MiB message cap (none before).
Verification: 6/6 `test/acp.test.mjs` (4 drive the real `oasis acp` process); the updated test fails on the old implementation; the SDK's `client()` connected to `oasis acp` over stdio gets initialize and a -32000 "no provider" error, and the process exits 0 on stdin EOF.

## 18. MCP server: @modelcontextprotocol/server

Replaced: the readline JSON-RPC loop, fixed `PROTOCOL_VERSION = '2025-06-18'`, and the hand-built initialize/tools/list/tools/call/error replies in `src/mcp-serve.mjs`.
Adopted: `@modelcontextprotocol/server` 2.4.0 (MIT): low-level `Server` with `tools/list` and `tools/call` handlers, `StdioServerTransport`, and `InMemoryTransport` for the in-process `createMcpServeHandler`.
Gains: version negotiation over SUPPORTED_PROTOCOL_VERSIONS (a 2025-11-25 client got 2025-06-18 before, now gets 2025-11-25; a 2024-11-05 client gets 2024-11-05), `ping`, initialize validation, and the SDK's own spec maintenance.
Verification: 4/4 `test/mcp-serve.test.mjs` (including the stdio test with the SDK client and the git-hook refusal); the negotiation assertion fails on the old server. The official conformance suite's server mode needs an HTTP URL; `oasis mcp serve` is stdio-only, so it was not run.

## 19. Browser Markdown: marked

Replaced: the line/regex Markdown renderer in `app/markdown.mjs` (99 lines).
Adopted: `marked` 18.1.3 (MIT, 0 dependencies, 558 KB unpacked; the ESM build is vendored through `APP_PACKAGES`, the import map with an updated CSP hash, and the service-worker precache).
Safety is enforced in renderer overrides: `html` tokens are escaped, `link`/`image` hrefs must match `^(https?:|mailto:)`, images render as links, and code is escaped with `data-lang` restricted to `[\w+#.-]`. Probes (`<img onerror>`, `<script>`, `javascript:` in links/images in any case, entity-encoded `&#106;avascript:`, `data:` URLs, title-attribute injection) all render inert.
Measured differences vs old: nested lists were flattened into one list before; `[wiki](…Foo_(bar))` lost `)` before; tables with alignment now carry `align`. The new app-core assertions fail on the old renderer. The Chrome end-to-end app test passes with the vendored module.
Not chosen: DOMPurify as a second layer, since it needs a DOM and the renderer is also used where there is none; markdown-it is heavier and similar in quality.

## 20. Terminal inline Markdown: marked Lexer.lexInline

Replaced: the five-regex inline pass in `renderInline` (`src/markdown.mjs`).
Adopted: `Lexer.lexInline(text, { gfm: true })` from the same `marked` package, with tokens drawn as ANSI (strong/em/del/codespan/OSC-8 links for http(s); other links and HTML stay literal).
Kept: the line-oriented block handling, because replies stream line by line and a block parser would need the full text.
Differences vs old (all CommonMark-conformant): nested emphasis renders, `\*x\*` shows `*x*` (it showed backslashes), `[w](…a_(b))` keeps the `)`, bare `https://` URLs become links, and intraword `2*3*4` italicises `3` per the spec.
Cost: USER_GUIDE (1,560 lines) 8 → 25 ms. The new test fails on the old function.

## 21. Terminal syntax highlighting: lowlight + highlight.js

Replaced: `highlightCode` keyword set, the hash-comment language list and the comment/string/number regex (`src/markdown.mjs`).
Adopted: `lowlight` 3.3.0 (wooorm, MIT) with `highlight.js` 11.11 (BSD-3-Clause), `common` grammar set (37 languages) and a `patch` alias for `diff`. Verified usage elsewhere: `google-gemini/gemini-cli` packages/cli depends on lowlight 3.3.0 and highlight.js 11.11.1; Codex's TUI uses syntect, the Rust counterpart.
The hast tree is painted with one ANSI colour per scope; nested spans re-emit the parent colour on exit (the old highlighter reset to the default colour).
Cost: 60 µs per line vs 4 µs (2,000 JS lines 119 ms vs 8 ms). Eager import added 74 ms to `src/markdown.mjs` import (61 → 135 ms) because lowlight's single entry imports every grammar; it is now loaded with `createRequire` (require(esm), Node ≥ 22.12) on first use, so import stays 61 ms and the first highlighted line takes ~89 ms. On older Node 22 builds the require fails and code stays plain.
Trade-off: unlabelled fences are no longer guessed at (the old generic regex coloured them); auto-detection per streamed line is unreliable.

## 22. SSE parsing: eventsource-parser

Replaced: `consumeServerSentEvents` (CLI) and `sseEvents` (browser app), two separate hand-written line splitters.

Chosen: `eventsource-parser` 4.1.3 (MIT, zero dependencies; the MCP SDK already pulls in 3.x as a transitive dependency, and it is widely used by the Vercel AI SDK). It implements the WHATWG EventSource parsing algorithm.

Verified behaviour (negative-controlled: both tests fail against the old code):
- CR-only line endings, and a CRLF split across two network reads.
- `:` comment lines ignored; several `data:` lines joined with `\n`.
- The library drops a final event with no blank line after it; OASIS feeds `"\n\n"` at EOF so that event is still delivered (as the old CLI parser did).
- Kept: 8 MiB `MAX_PROVIDER_STREAM_BYTES` cap, `onStray` reporting (through the `unknown-field` error), and event name `''` as the default.

Browser app: vendored through `APP_PACKAGES` (`dist/index.js`), with an importmap entry, a recomputed CSP hash, and a service-worker precache entry.

## 23. Terminal word wrap: wrap-ansi

Replaced: the custom ANSI tokenizer and greedy wrapper in `wrapRendered` (`src/markdown.mjs`).

Chosen: `wrap-ansi` 10.0.2 (MIT, sindresorhus; used by Ink, cliui and many CLIs). It adds only `ansi-styles` and dedupes onto the string-width 8.3 already in use.

Verified:
- The old code carried an open background colour across the break (`\x1b[44m...six\n  seven...`), so the indent was painted. wrap-ansi closes the colour before the break and reopens it after the indent. The new test in `test/markdown.test.mjs` fails on the old code.
- Plain-text output matches the old wrapper on bullets, numbered CJK text, indented tips and coloured prose (4 of 5 probe cases). The one difference is an overlong URL, which wrap-ansi hard-splits at its starting position.
- wrap-ansi has a single width, but a hanging indent needs two (first row versus continuation rows). The first row is cut with `trim:false`, which round-trips the text exactly, and the remainder is wrapped at the continuation width.

Not replaced: the conservative shell splitter in `src/permissions.mjs`. It is a deliberate fail-closed allow-rule check that is already paired with the tree-sitter-bash AST for deny/ask matching (reviewed earlier).

## 24. Version comparison: semver

Replaced: `parseVersion`/`compareVersions` (`src/app-update.mjs`) and `validVersion`/`parseVersion`/`comparePrereleaseIdentifier`/`compareVersion` (`src/native-plugins.mjs`). These were two independent SemVer implementations.

Chosen: `semver` 7.8.6 (ISC, npm's own implementation, zero dependencies, already in the tree through electron-builder).

Verified:
- 15 probe versions (`v` prefix, padding, rc.2 vs rc.10, alpha vs beta, build metadata, `-0`) give 225 ordered pairs, and old and new comparisons agree on every one.
- Native plugins stay strict through `semver.valid(v) === v`, which rejects a `v` prefix, build metadata, and leading zeros in core or numeric prerelease identifiers.
- Deliberate change: the old BigInt comparator accepted `999999999999999999999.0.0`. semver rejects components above `Number.MAX_SAFE_INTEGER`, as the npm registry does, so such a manifest now fails validation (fail closed). The test now asserts this, and that `9007199254740991.0.0` still installs.

## 25. Recall ranking: MiniSearch + Porter2

Replaced: two copies of hand-written BM25 (k1 1.2, b 0.75), one in session search and one in auto-memory `rankMemories`, plus auto-memory's suffix stripper.

Chosen:
- `minisearch` 7.2.0 (MIT, zero dependencies; BM25+, field boosts, prefix and fuzzy search; widely used for in-process search).
- `wink-porter2-stemmer` 2.0.1 (MIT, zero dependencies; Snowball English / Porter2).

Rejected: wooorm `stemmer` 2.0.1, which implements the original Porter algorithm. It stems `deploy`, `deployed` and `deploying` to `deploi` but `deployments` to `deploy`, so the query "deployments" missed a memory about "deployed". Porter2 maps all four to `deploy`.

Verified:
- 8 probe queries over 5 memories give identical top results before and after.
- New tests fail on the old code: "auth config" now finds an "authentication … configuration" session, and "deployments" and "config" find the matching memory.
- Unchanged: stopwords, NFKC tokenizing for sessions, name/description weighed double (now field boosts), the phrase ×1.5 and query-coverage factors, recency and recall boosts, and the two-excerpts-per-session cap.
- Queries are passed to MiniSearch already tokenized (plain split), so stemmed terms are not stemmed twice.

## 26. HTML extraction complexity fix (follow-up to §16)

§16 rejected parse5 and htmlparser2, which are quadratic on deep nesting, and kept the OASIS parser. That left the extraction passes as the bottleneck. `cleanConditionally`, `looksLikeProse` and `scoreCandidates` called `textOf`, `walk` and `linkTextLength` on each candidate, so every node's subtree was walked once per ancestor.

Fix: `statsOf(node, memo)` caches per-subtree aggregates for each pass: link count, link-text length, has pre / h1 / h1–h3, comma count, and the exact length of `textOf(n).replace(/\s+/g,' ').trim()`. That length is kept additive as a collapsed-run triple (size, starts-with-space, ends-with-space). A pass only rewrites a node's children after deciding about that node, so the cache stays valid within the pass.

Measured on Node 22, sandbox:

| Input | Before | After |
|---|---|---|
| 100k nested divs (1.1 MB) | 4490 ms | 518 ms |
| 20k nested link blocks (1.0 MB) | 4059 ms | 508 ms |
| 40k nested link blocks | 8606 ms | ~1 s |
| Real pages (Wikipedia, MDN, GitHub, Node util docs, HN, Python re docs) | 17–153 ms | 6–127 ms |

Equivalence: the full serialized result (title, description, markdown, flags) was compared old against new. It was identical on 4000 seeded random documents (nav/sidebar classes, hidden/role attributes, CJK commas, whitespace runs) and on all six real pages. Regression test: `test/html-markdown.test.mjs` "extraction stays linear…" (bound 4 s; the old code takes 8.6 s).

Also evaluated and deferred: replacing the ~270-line flag loop in `src/cli.mjs` with commander or yargs. That loop encodes exact Claude Code, Codex, Gemini CLI and Aider compatibility: optional values (`-p [prompt]`, `-r [id]`, `-w [name]`, `--debug [cats]`), variadic `--betas`, and unknown arguments falling through to subcommands. A wholesale swap carries high regression risk for no user-visible gain. Revisit with a declarative flag table plus `util.parseArgs` if the flag set keeps growing.

## 27. CDP WebSocket: Node's built-in WebSocket (undici)

Replaced: the `WsClient` class in `src/cdp.mjs`, a hand-written RFC 6455 client (handshake, SHA-1 accept check, masking, 7/16/64-bit lengths, fragments, ping/pong). It was justified by "Node 20 has no global WebSocket", but `engines` is now `>=22` and Node 22 ships the WHATWG WebSocket (undici). The Discord and Slack gateways and WebSocket monitors already used it.

Verified with headless Chromium 1217 through `Browser.launch()`: `Runtime.evaluate` with Unicode, a 2× PNG screenshot, a 5,000,000-character result, `Page.loadEventFired` events, and the Chrome-driven e2e tests (`browser-navigation-e2e`, `browser-tool`, `app-e2e`, `app-runtime-e2e`). Chrome accepts the connection; undici sends no `Origin`, so `--remote-allow-origins` is not needed.

## 28. QR encoder: uqr

Replaced: about 230 lines of Nayuki-derived encoding in `src/qr.mjs` (Reed–Solomon, masks, penalty scoring, version info).

Chosen: `uqr` 0.1.3 (unjs, MIT, zero dependencies; itself a Nayuki port, with `boostEcc:false` to keep the requested level). It reproduces both python-qrcode reference fingerprints in `test/qr.test.mjs` exactly (v5 with mask 2, and v13 with version-info blocks). Rejected: `qrcode` 1.5.4, which depends on yargs 15, pngjs and dijkstrajs. The OASIS half-block terminal renderer stays, since it is presentation policy.

## 29. Outbound proxy: undici ProxyAgent

Replaced: `createProxyFetch`'s hand-made transport in `src/proxy.mjs`: per-request CONNECT plus `https.request`, absolute-URI `http.request`, a manual 20-hop redirect loop with credential stripping, and URLSearchParams and Uint8Array body conversion.

Chosen: `undici` 7.30.2 (MIT, the Node.js project's HTTP client). It uses `fetch` with a `ProxyAgent` dispatcher, one per proxy URL. undici 8 was not chosen because it requires Node ≥ 22.19, while OASIS supports ≥ 22.0. It is imported lazily on the first proxied request, since it costs ~80 ms (`proxy.mjs` import stays 28 ms).

Kept as OASIS policy: proxy selection per scheme, NO_PROXY (host, .domain, *.domain, host:port, IP, CIDR, *), loopback always direct, OASIS_PROXY=0, the `Proxy-Authorization` built from URL credentials (passed as `token`, which also covers username-only credentials), and `proxyTunnel:false` so plain `http://` is forwarded rather than CONNECT-ed. `openTunnel` stays for `public-fetch`, which must tunnel to the exact IP that passed the private-network check.

Fixed: `Request` objects and ReadableStream or FormData bodies used to fall through to direct connections, silently bypassing a corporate proxy. The new test "Request objects and streamed bodies also go through the proxy" fails on the old code.

Behaviour changes (tests updated):
- `redirect:'error'` now rejects like Node's fetch (`TypeError('fetch failed')` with `cause: unexpected redirect`).
- A proxy 407 on plain `http://` is now an error with the credentials hint instead of a 407 response, matching CONNECT.

## 30. Zip reader: kept (yauzl and fflate evaluated)

`src/zip.mjs` stays. fflate's `unzipSync` exposes no external attributes, so it cannot detect symlinks or keep executable bits. yauzl 3 "ignores the content of the Local File Header" apart from its signature (README). OASIS rejects archives whose local and central names disagree, which defends against parser-confusion archives in plugin installs. Neither library checks more than OASIS already does, so swapping would weaken the installer.

## 31. Terminal Mermaid: beautiful-mermaid evaluated, not adopted

Candidate: `beautiful-mermaid` 1.1.3 (lukilabs/Craft, MIT; ASCII engine ported from Go mermaid-ascii). It covers flowchart, sequence, state, class, ER and XY charts.

Side-by-side against `src/mermaid-ascii.mjs`, on Node 22 with `paddingY:1, boxBorderPadding:0`:
- Flowchart: draws back edges, which OASIS lists as `↺ A → B`. However, `flowchart LR … d -- fail --> c` was drawn forwards as `Edit ─fail─► Test`, and subgraph membership was wrong (`C` placed outside `Group`).
- Sequence: a `loop` block rendered as `┌loop [t┐` with the self-message outside its lifeline. OASIS renders it correctly.
- CJK labels: box widths use UTF-16 length, so `前端` overflows its box (a known upstream gap; beautiful-mermaid-cli vendors a patch).
- ER: garbled cardinality glyphs.
- State, class and XY chart: good output. OASIS shows the source for these.
- Cost: 3.3 MB, plus elkjs at 7.7 MB. ESM-only with no `require` condition, so the synchronous streaming renderer could only use it after an async preload (115 ms import).

Decision: keep the OASIS renderer for flowchart and sequence. Revisit beautiful-mermaid (or its maintained fork zombie-mermaid with a standalone `@zombie-mermaid/ascii-renderer`) for state, class and XY once CJK width is fixed upstream and a lighter ASCII-only entry exists.

## 32. Telemetry: official OpenTelemetry JS SDK replaces the hand-written exporter

- **Before:** `src/telemetry.mjs` built OTLP/HTTP JSON by hand (about 280 lines). Verified gaps: histograms had one bucket with no `explicitBounds`, failed exports were not retried, and `service.version` was hard-coded to `1`.
- **After:** `@opentelemetry/api` 1.10.0, `resources`, `sdk-metrics`, `sdk-logs` and `sdk-trace` 3.1.0, `otlp-transformer` and `exporter-{metrics,logs,trace}-otlp-http` 0.301.0, all pinned exactly because the experimental 0.x packages track the stable ones. The cost is 12 packages and 19 MB on disk (`semantic-conventions` alone is about 9 MB). Importing takes about 88 ms, so the SDK loads with a lazy `import()` only when telemetry is enabled. Calls made before it has loaded are queued.
- **What stays OASIS's own:** the public API (`Telemetry`, `getTelemetry`, `currentSpan`, …), an AsyncLocalStorage span wrapper whose `attrs`/`error` callers can change mid-span (applied at end), the opt-in rules for prompt and tool content, the git-branch attribute, and the `console` exporter format (`[otel <signal>] <OTLP JSON>`, produced with the SDK's own `Json*Serializer`).
- **Verified:** the SDK's retry policy is 5 attempts on 429/502/503/504 (`otlp-exporter-base/dist/retrying-transport.mjs`, `is-export-retryable.mjs`). The tests now run against a real local HTTP collector instead of an injected `fetch`. Negative control: the old module fails the new histogram-bounds assertion. Full suite: 2018 tests, 0 failures. `oasis --help` with telemetry on exits in 0.5 s, so no timers keep the process alive.
- **Not done:** OTLP protobuf and gRPC would need the `-proto`/`-grpc` exporter packages and are not added until someone needs them.

## Next

- Decided against Ajv validation in front of built-in tools: they already reject bad input with specific messages ("edit_file needs old_string … got path"), coerce numeric strings, and accept documented argument aliases that a strict schema would refuse.
- Live A/B of observation masking (solve rate and provider-reported tokens) before considering it as a default for local providers.
- Merge the definition and noise queries into one pass, or parse in a worker
  pool, if first-scan latency matters for large repositories.
