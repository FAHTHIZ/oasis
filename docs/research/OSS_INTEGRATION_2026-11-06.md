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

## Next

- Decided against Ajv validation in front of built-in tools: they already reject bad input with specific messages ("edit_file needs old_string … got path"), coerce numeric strings, and accept documented argument aliases that a strict schema would refuse.
- Live A/B of observation masking (solve rate and provider-reported tokens) before considering it as a default for local providers.
- Merge the definition and noise queries into one pass, or parse in a worker
  pool, if first-scan latency matters for large repositories.
