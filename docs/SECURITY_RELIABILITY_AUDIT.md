# Security and reliability audit

**Audit date:** October 29, 2026  
**Code baseline reviewed:** [`a044ed403091a2fb885ff796bd364f010a13e286`](https://github.com/FAHTHIZ/oasis/commit/a044ed403091a2fb885ff796bd364f010a13e286)  
**Verification:** [Quality Checks](https://github.com/FAHTHIZ/oasis/actions/runs/40804769809) passed with 570 tests on Node 22/24/26 and 21 valid evaluation fixtures; [publishing validation](https://github.com/FAHTHIZ/oasis/actions/runs/40804769832) passed; [desktop packaging](https://github.com/FAHTHIZ/oasis/actions/runs/40804769799) passed on Windows, macOS and Linux. These are regression/packaging checks, not a penetration test. See [Current status](CURRENT_STATUS.md).

This is an initial source-level security/reliability pass, not a penetration test and not a claim that every defect has been found. It focused on network boundaries, command lifecycle, workspace paths, runtime authentication, MCP/plugin trust and hook execution. Findings below distinguish direct fixes from open risks.

## Concrete findings fixed on main

### Browser navigation approval could be reused across opaque URL targets

The browser tool cached approvals by `URL.origin`. `data:` URLs share the opaque origin string `null`; `file:` URLs do not have normal web-origin semantics; and the previous implementation treated every `about:` URL as inherently local. Approving one opaque target could therefore be reused for another.

**Fix committed:** approval for `data:`, `file:` and non-blank `about:` targets is now bound to the exact normalized URL. Only loopback HTTP(S) and exact `about:blank` bypass the navigation prompt. URLs with embedded username/password values are rejected and URL length is capped at 32 KiB. Chrome DevTools Fetch interception now gates main-frame document requests initiated by links, forms, redirects and page scripts, not just explicit `browser.navigate` actions. Requests from page content to explicit local/private/special-purpose targets (loopback, private/link-local IPs, metadata and common internal hostnames) are also approval-gated across document and subresource types; ordinary public subresources continue normally. Direct user-requested loopback navigation remains convenient for local development, but page-initiated access to a fresh local target must ask. This is hostname/IP filtering, not a complete defense against DNS rebinding or a replacement for network-level egress policy. Denied requests are failed before proceeding.

**Regression coverage:** standalone unit tests cover origin-scoped approvals for normal web URLs, exact-target approvals for opaque URLs, loopback/`about:blank` handling and URL-size/userinfo constraints. Live interception still needs the browser E2E workflow to pass.


### 1. Child processes could survive command cancellation and timeout

The earlier command path signalled only the immediate child process. If a command created a grandchild that inherited stdout/stderr, that descendant could keep running, mutate files or keep the command completion event waiting. This affected normal commands and similar subprocess paths such as package installs, external skill installation and shell hooks.

**Fix committed:** `src/process-tree.mjs` now provides process-tree signalling. On POSIX, OASIS starts relevant processes in their own process group and signals the group; after a grace period it escalates to a forced stop. On Windows, the forced-stop path uses `taskkill /T /F`. The helper is wired into regular command execution, package installation, external skill installation and command-hook timeout/cancellation.

**Regression coverage:** `test/runtime.test.mjs` now spawns a long-running descendant that inherits output handles and asserts cancellation completes, rather than testing only a single child.

**Not yet claimed closed:** Windows process-tree behavior and all native PTY cleanup scenarios still require platform-specific verification. A code change alone is not that verification.

### 2. The FileChanged hook test could assert before its message was delivered

The failing test waited for a log file entry from the hook. The hook writes that log before OASIS has necessarily parsed the response and placed its `systemMessage` into `hookMessages`, so the assertion could run too early.

**Fix committed:** the test now waits for the observable hook-message condition using the existing bounded `waitFor` helper. This fixes the test synchronization without adding a blind delay, suppressing retries, or weakening the assertion. The new publishing-validation run must still pass before the fix is called verified.

### 3. Public URL fetching missed additional special-purpose address ranges

The fetch guard already blocked private/local IPs, validated DNS answers, pinned accepted DNS results to mitigate rebinding, limited response size/time, and did not automatically follow redirects. Its IP policy did not cover several additional reserved/documentation or IPv6 transition/documentation ranges.

**Fix committed:** added additional IPv4 special-purpose/documentation blocks and IPv6 non-global/documentation/transition blocks, plus regression cases in `test/runtime.test.mjs`.

The policy is intentionally conservative. It is defense in depth, not a replacement for an outbound firewall or network-level egress policy.

### 4. OAuth endpoint validation could be undermined by a second DNS lookup

The OAuth discovery flow validates metadata and token endpoints against local/private/special-purpose destinations. Using the ordinary fetch implementation would perform another hostname resolution at connect time, creating a DNS-rebinding window between validation and the actual request.

**Fix committed:** OAuth HTTP(S) requests now use the approved DNS answer set for the socket lookup after validating every returned address. Redirects are handled manually and each destination is validated again. Localhost access is pinned to loopback for the configured local MCP origin.

**Regression coverage:** OAuth tests exercise loopback hostname normalization and safe discovery behavior. Continue adversarial testing of mixed public/private DNS answers, IPv4-mapped IPv6 and redirects.

### 5. Plugin archive downloads and ZIP extraction needed stronger boundaries

The archive importer needed to guard against SSRF via redirects or unusual IP ranges, oversized responses, path traversal, Windows-specific path semantics, duplicate/case-colliding names, malformed central/local headers and writes through symlinks.

**Fix committed:** downloads accept HTTP(S) only, require HTTPS for non-loopback targets, reject embedded credentials and private/special-purpose destinations, pin DNS answers, validate each redirect, cap download size/time, and reject public-to-loopback redirects. ZIP handling now bounds central/local records and expanded size, rejects ZIP64/multi-disk input, unsafe and non-portable paths, duplicate/case-colliding names, symlinks and declared-size mismatches, and refuses symlinked extraction parents. Session-scoped plugin archive roots are cleaned on normal CLI exit.

**Regression coverage:** `test/zip.test.mjs` covers traversal, absolute/drive paths, NUL and Windows-reserved names, duplicate/case-colliding entries, malformed headers, symlink defenses, URL restrictions, redirect revalidation and size limits. Cleanup on crashes/forced termination is not guaranteed; third-party plugin code remains trusted code once enabled.

### 6. API-key helper caching and timeout cleanup could cross workspace boundaries

Caching helper results only by command string could reuse a credential produced in another working directory or environment. A timeout that killed only the shell process could leave descendants running.

**Fix committed:** cache entries are keyed by command, resolved working directory and a digest of the environment; helper output remains bounded, and timeout handling signals the process tree with one-shot promise settlement.

**Regression coverage:** tests cover cwd/environment cache isolation, invalid TTL fallback and timeout cleanup. Platform-specific process-tree behavior outside the tested POSIX CI environment remains open.

## Controls observed in source

- **Browser runtime:** API requests require a random bearer token with timing-safe comparison. Host/Origin checks constrain browser access, CORS is not broadly enabled, request bodies are capped, and API responses are marked `no-store`.
- **Network listener:** non-loopback access requires HTTPS unless the operator explicitly opts into `--allow-insecure-lan`. TLS 1.2+ is required when certificate and key files are supplied. Insecure LAN mode intentionally makes traffic observable on that network and should not be used on public/untrusted networks.
- **Workspace filesystem:** workspace paths are resolved against real roots, sensitive paths are blocked, symlinks are checked and direct symlink writes/deletes are rejected. Tool-managed modifications use snapshots/freshness checks where supported.
- **Command execution:** ordinary commands use executable-plus-argv spawning rather than implicit shell expansion, pass command-policy analysis, and request approval by default. Child environments remove common credential-named variables.
- **Extension import:** reviewed GitHub import limits collected data, imports Markdown instructions rather than executing repository scripts, and MCP proposals remain disabled until approved. Imported instructions are still untrusted input.
- **UI templates:** the dynamic `index.html` templates inspected in this pass pass local/imported values through HTML-escaping helpers; transcript text uses text nodes. This was a focused source review, not a full XSS audit.

Source references: [web server](../src/web.mjs), [workspace tools and URL guard](../src/tools.mjs), [process-tree helper](../src/process-tree.mjs), [command policy](../src/permissions.mjs), [optional OS sandbox](../src/sandbox.mjs), [MCP runtime](../src/mcp.mjs), [hook runtime](../src/hooks.mjs).

## High-impact risks that remain open

1. **Approved commands still inherit the user's authority.** The optional Linux/macOS sandbox is disabled by default; no Windows sandbox or general container isolation is implemented. Permission prompts are consent gates, not OS isolation.
2. **MCP servers, shell hooks and enabled third-party plugin executables are trusted code.** Once explicitly enabled, they can perform actions available to the user, subject to the actual permission/environment restrictions. Review each integration and pass only required environment values.
3. **Filesystem race resistance is not a formal TOCTOU guarantee.** Symlink validation reduces traversal risk, but path-based Node filesystem operations can race if an attacker can concurrently alter directories. Use private/trusted workspaces; stronger resistance would require descriptor-relative secure filesystem operations.
4. **Cross-platform process-tree cleanup is not yet proven.** Linux/Node 22 is the existing native PTY CI target. POSIX process-group and Windows `taskkill` escalation need tests for child/grandchild processes, cancellation, timeouts and clean shutdown on supported operating systems.
5. **HTTPS provisioning is operator-managed.** Certificate issuance/renewal and trusted-device onboarding are not turnkey. Do not enable `--allow-insecure-lan` on untrusted networks or port-forward/publish the local runtime to the Internet.
6. **Browser dashboard data is unencrypted local storage.** Do not put credentials or sensitive personal information into browser projects/tasks/notes. The runtime connection token in browser session storage must be treated as a secret.
7. **Desktop installers are unsigned.** Packaging success does not establish signer identity, first-run/update/uninstall success or accessibility on every platform.
8. **Secret storage has platform-specific residual risk.** The macOS Keychain write path currently passes the secret as an argument to the `security` subprocess; a same-user process with process-inspection access may observe it. Prefer a native Security-framework helper or another non-argv transport before calling this path fully secret-safe. On Windows, file fallback permissions also need explicit ACL verification rather than assuming POSIX `0600` semantics.
9. **Temporary plugin cleanup is best-effort.** Normal process exit removes the temporary extraction root, but a crash or forced termination can leave files in the OS temporary directory; stale-root cleanup and crash-recovery tests remain useful.
10. **Tests are not a full security audit.** The 21-task evaluation suite is a smoke benchmark. Passing it does not prove all provider, platform or adversarial cases are safe.

## Required verification

- [ ] Verify browser-navigation guards for same-origin navigation, cross-origin click/form/redirect behavior, opaque data/file URLs, and denied navigation with live Chrome E2E tests.
- [ ] Re-run the Chrome tool E2E test on Node.js 22/24/26; the Node 26 job previously timed out waiting for DevTools during Chrome startup, so startup reliability remains open.

- [x] Current Quality Checks passes with the process-tree descendant test and new URL/archive regression tests: https://github.com/FAHTHIZ/oasis/actions/runs/40804769809.
- [x] Publishing validation passes on the same code commit, including the corrected FileChanged hook test: https://github.com/FAHTHIZ/oasis/actions/runs/40804769832.
- [x] Desktop packaging completed on the same code commit for Windows, macOS and Linux: https://github.com/FAHTHIZ/oasis/actions/runs/40804769799.
- [ ] Repeat cancellation/timeout tests and confirm descendants are stopped and inherited pipes close.
- [ ] Run process-tree cancellation tests on Windows as well as POSIX before claiming cross-platform closure.
- [ ] Continue adversarial URL tests for normalization, IPv4-mapped IPv6, DNS answer sets, redirects and provider/network failure cases.

**Bottom line:** three concrete weaknesses have been patched on main, but the high-impact execution/trust boundaries above remain. This audit does not claim exhaustive coverage or zero remaining bugs.
