# Security and reliability audit

**Audit date:** October 29, 2026  
**Code baseline reviewed:** [`02feecc610f5775279b827a51744bc244e725068`](https://github.com/FAHTHIZ/oasis/commit/02feecc610f5775279b827a51744bc244e725068)  
**Verification:** the latest main-branch Quality Checks, publishing validation and desktop-build workflows were still running at the time of this update. See [Current status](CURRENT_STATUS.md).

This is an initial source-level security/reliability pass, not a penetration test and not a claim that every defect has been found. It focused on network boundaries, command lifecycle, workspace paths, runtime authentication, MCP/plugin trust and hook execution. Findings below distinguish direct fixes from open risks.

## Concrete findings fixed on main

### Browser navigation approval could be reused across opaque URL targets

The browser tool cached approvals by `URL.origin`. `data:` URLs share the opaque origin string `null`; `file:` URLs do not have normal web-origin semantics; and the previous implementation treated every `about:` URL as inherently local. Approving one opaque target could therefore be reused for another.

**Fix committed:** approval for `data:`, `file:` and non-blank `about:` targets is now bound to the exact normalized URL. Only loopback HTTP(S) and exact `about:blank` bypass the navigation prompt. URLs with embedded username/password values are rejected and URL length is capped at 32 KiB. Chrome DevTools Fetch interception now gates main-frame document requests initiated by links, forms, redirects and page scripts, not just explicit `browser.navigate` actions. Denied navigations are failed before their document request proceeds.

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
8. **Tests are not a full security audit.** The 21-task evaluation suite is a smoke benchmark. Passing it does not prove all provider, platform or adversarial cases are safe.

## Required verification

- [ ] Verify browser-navigation guards for same-origin navigation, cross-origin click/form/redirect behavior, opaque data/file URLs, and denied navigation with live Chrome E2E tests.
- [ ] Re-run the Chrome tool E2E test on Node.js 22/24/26; the Node 26 job previously timed out waiting for DevTools during Chrome startup, so startup reliability remains open.

- [ ] Current Quality Checks passes with the process-tree descendant test and new IP-range tests.
- [ ] Publishing validation passes on the same commit, including the corrected FileChanged hook test.
- [ ] Desktop packaging completes on the same commit.
- [ ] Repeat cancellation/timeout tests and confirm descendants are stopped and inherited pipes close.
- [ ] Run process-tree cancellation tests on Windows as well as POSIX before claiming cross-platform closure.
- [ ] Continue adversarial URL tests for normalization, IPv4-mapped IPv6, DNS answer sets, redirects and provider/network failure cases.

**Bottom line:** three concrete weaknesses have been patched on main, but the high-impact execution/trust boundaries above remain. This audit does not claim exhaustive coverage or zero remaining bugs.
