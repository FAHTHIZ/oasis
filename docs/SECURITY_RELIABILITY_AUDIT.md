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

## Follow-up hardening: shared IP policy and secret-safe Keychain storage

**Implementation commit:** this section records changes added after the original audit baseline. The accompanying Quality Checks, browser E2E and desktop workflows must be checked on the exact resulting commit before this is treated as verified release evidence.

### Shared IP-address policy across network boundaries

The URL fetcher, plugin archive downloader, MCP OAuth discovery and browser request interception previously maintained separate IPv4/IPv6 classifiers. The policy drift left several non-global IPv6 forms inconsistently covered, including discard-only/dummy/SRv6 ranges outside global unicast and the full deprecated site-local range.

**Fix:** src/network-safety.mjs now owns the shared classifier and those four features use it. Existing hostname validation, DNS-answer pinning, manual redirect validation and local-target restrictions remain in place. Plugin archive validation classifies IP literals before its single-label-hostname rule, avoiding a false classification of IPv6 literals.

**Regression coverage:** test/network-safety.test.mjs exercises non-public IPv6 targets across public fetch, plugin import and OAuth discovery, and ensures ordinary public IPs remain fetchable. Browser tests also cover the private-network blocking policy.

This remains defense in depth: the browser URL filter does not substitute for OS/network egress controls, and this change is not a penetration test.

### macOS Keychain secret exposure in process arguments

The previous Keychain writer passed secret values as the -w argument to security add-generic-password. That puts the secret in the child process argument vector, where it can be exposed by process inspection or diagnostics.

**Fix:** OASIS now invokes the security -i interactive parser and supplies an -X hex-encoded value via stdin; the child process arguments contain only -i. Account/label data is quoted and escaped, control characters are rejected to prevent command-line breakout, and oversized input fails closed so the existing protected-file fallback can be used rather than reverting to secret-in-argv.

**Regression coverage:** test/secure-store.test.mjs verifies that the secret is not in process argv, account control characters are rejected, and oversized commands fail closed. The Keychain interaction itself still needs real macOS runtime validation; unit tests use an injected runner.

### Remote package execution and high-impact runner approvals

The command analyzer already marked inline interpreter evaluation and selected wrappers as high risk. A further review identified a narrow gap around remote package-execution helpers and explicit high-impact runner verbs, which may execute code not previously reviewed as part of the workspace.

**Fix:** the policy now requires interactive high-risk approval for helpers such as npx/bunx, package-manager exec/dlx/install/publish operations, non-test deploy/release package scripts, Cargo/Go run commands, and explicit deploy/release/install targets. Existing normal-risk behavior for direct local scripts and conventional test/check commands is preserved; changing that broader policy would require a deliberate compatibility decision.

**Regression coverage:** test/command-risk.test.mjs covers remote package helpers and high-impact verbs, while asserting that ordinary scripts and common test/check commands retain their previous classification. High-risk operations still need real interactive approval; --yes alone does not override the high-risk gate.

### Broader IPv6 protocol-assignment block

The shared IP policy previously covered selected subranges of IANA's 2001::/23 special-purpose registry block. The selective list risked missing other assignments, and the first broadening pass dropped an older 2001:db8::/32 exclusion.

**Fix:** the policy rejects the whole 2001::/23 block while preserving the documentation and transition exclusions outside that range, including 2001:db8::/32 and 2001:4:112::/48, conservatively treating them as special-purpose for outbound SSRF checks.

**Regression coverage:** shared-network tests cover addresses near the start, middle, and end of that block.

### NAT64-encoded private destinations

The shared address classifier initially handled IPv4-mapped IPv6 addresses but not IPv4-IPv6 translation prefixes. A local service could be reachable through NAT64 even though the outer IPv6 address did not match ordinary private IPv6 ranges.

**Fix:** the well-known `64:ff9b::/96` translation prefix now applies the IPv4 private/special-address policy to the embedded IPv4 destination. The local-use `64:ff9b:1::/48` prefix is rejected outright because it is not globally reachable.

**Regression coverage:** `test/network-safety.test.mjs` covers NAT64-encoded RFC1918 and link-local destinations across network entry points while checking that a public embedded IPv4 address remains eligible.

### Browser handling of public IPv6 literals

The browser request filter also treated every hostname without a dot as a local/single-label hostname, which unintentionally blocked public IPv6 literals. It now distinguishes IP literals with Node's isIP before applying the single-label DNS hostname rule, and passes IP literals through the shared classifier.

**Regression coverage:** test/browser-tool.test.mjs asserts that the public IPv6 fixture is allowed while loopback and private/special-purpose literals remain blocked.

### Cloud-provider credential-context isolation

Google Cloud and Microsoft Foundry token helpers previously kept a single module-level token for up to 45 minutes. In an embedded process that uses more than one cloud profile or project, a later request could receive the previously cached identity's token.

**Fix:** token caches are now keyed by the relevant local CLI profile, credentials-file path, tenant/account and project/resource context. Expired entries are removed on read, and caches have a bounded entry count. Explicit access tokens supplied through the supported environment variables still take precedence over cached CLI credentials.

**Regression coverage:** test/cloud-providers.test.mjs switches between two fake Google and two fake Azure credential contexts, verifies that each gets its own token, and confirms the cache is reused only within the same context. The tests validate application cache selection, not the external cloud CLIs' account selection.

### Optional sandbox credential masking and limits

The opt-in Linux/macOS sandbox previously restricted writes and could block network access, but left host-readable credential stores in view. A script running inside the sandbox could still attempt to read common home-directory credential locations.

**Fix:** when the OS sandbox is enabled, OASIS now detects and masks common credential roots/files (SSH, AWS, Azure, Kubernetes, Docker, GnuPG, GitHub CLI, Google Cloud, OASIS config, Claude/Codex config, and common netrc/npmrc/Git credential files). Linux overlays directories with tmpfs and masks standalone files with an empty read-only `/dev/null` bind; macOS Seatbelt adds matching read-deny rules. Credential masks override workspace and additional-directory write mounts. Only the explicit, trusted `sandbox.maskSensitivePaths: false` setting opts out; broad write grants do not implicitly expose credentials.

**Regression coverage:** `test/power.test.mjs` checks the generated Linux argv and macOS Seatbelt rules. Actual sandbox behavior still needs runtime validation on macOS, and Windows remains unsupported. This is not complete filesystem-read isolation: unlisted secret locations may remain readable, and network isolation can be enabled by the user.

### Command-risk policy bypass through package-manager options

The high-impact runner guard and package-publishing block initially examined only the first argument, so forms like `npm --prefix ./app run deploy` could skip the intended classification.

**Fix:** package-manager action parsing now skips common global options before examining verbs. The publication block and high-risk classification share that parsed action.

**Regression coverage:** `test/command-risk.test.mjs` covers option-prefixed npm/pnpm/yarn script execution and confirms publishing remains blocked with options before the verb.

## High-impact risks that remain open

1. **Approved commands still inherit the user's authority.** The optional Linux/macOS sandbox is disabled by default; no Windows sandbox or general container isolation is implemented. Permission prompts are consent gates, not OS isolation.
2. **MCP servers, shell hooks and enabled third-party plugin executables are trusted code.** Once explicitly enabled, they can perform actions available to the user, subject to the actual permission/environment restrictions. Review each integration and pass only required environment values.
3. **Filesystem race resistance is not a formal TOCTOU guarantee.** Symlink validation reduces traversal risk, but path-based Node filesystem operations can race if an attacker can concurrently alter directories. Use private/trusted workspaces; stronger resistance would require descriptor-relative secure filesystem operations.
4. **Cross-platform process-tree cleanup is not yet proven.** Linux/Node 22 is the existing native PTY CI target. POSIX process-group and Windows `taskkill` escalation need tests for child/grandchild processes, cancellation, timeouts and clean shutdown on supported operating systems.
5. **HTTPS provisioning is operator-managed.** Certificate issuance/renewal and trusted-device onboarding are not turnkey. Do not enable `--allow-insecure-lan` on untrusted networks or port-forward/publish the local runtime to the Internet.
6. **Browser dashboard data is unencrypted local storage.** Do not put credentials or sensitive personal information into browser projects/tasks/notes. The runtime connection token in browser session storage must be treated as a secret.
7. **Desktop installers are unsigned.** Packaging success does not establish signer identity, first-run/update/uninstall success or accessibility on every platform.
8. **Secret storage needs platform-specific validation.** The macOS Keychain write path now supplies a hex-encoded secret through `security -i` stdin rather than a plaintext argument, with unit tests for argv isolation. A real macOS Keychain test is still required, and Windows file-fallback ACLs need explicit verification rather than assuming POSIX `0600` semantics.
9. **Temporary plugin cleanup is best-effort.** Normal process exit removes the temporary extraction root, but a crash or forced termination can leave files in the OS temporary directory; stale-root cleanup and crash-recovery tests remain useful.
10. **Tests are not a full security audit.** The 22-fixture evaluation suite is a smoke benchmark. Passing it does not prove all provider, platform or adversarial cases are safe.

## Required verification

- [ ] Verify browser-navigation guards for same-origin navigation, cross-origin click/form/redirect behavior, opaque data/file URLs, and denied navigation with live Chrome E2E tests.
- [ ] Re-run the Chrome tool E2E test on Node.js 22/24/26; the Node 26 job previously timed out waiting for DevTools during Chrome startup, so startup reliability remains open.

- [x] Current Quality Checks passes with the process-tree descendant test and new URL/archive regression tests: https://github.com/FAHTHIZ/oasis/actions/runs/40804769809.
- [x] Publishing validation passes on the same code commit, including the corrected FileChanged hook test: https://github.com/FAHTHIZ/oasis/actions/runs/40804769832.
- [x] Desktop packaging completed on the same code commit for Windows, macOS and Linux: https://github.com/FAHTHIZ/oasis/actions/runs/40804769799.
- [ ] Repeat cancellation/timeout tests and confirm descendants are stopped and inherited pipes close.
- [ ] Run process-tree cancellation tests on Windows as well as POSIX before claiming cross-platform closure.
- [ ] Continue adversarial URL tests for normalization, IPv4-mapped IPv6, DNS answer sets, redirects and provider/network failure cases.

**Bottom line:** multiple concrete security and reliability findings have been patched on main, including network-address policy consistency, secret-safe Keychain writes, cloud-token cache isolation, command-risk parsing, and optional sandbox credential masking. The latest follow-up still needs Quality Checks, publishing validation and desktop packaging to pass on one current SHA. This audit does not claim exhaustive coverage or zero remaining bugs.

## Follow-up hardening: macOS Seatbelt profile path injection

**Finding:** `macProfile()` inserts workspace, additional-writable-directory, and masked-sensitive paths into generated Seatbelt Profile Language (SBPL). The path renderer escaped backslashes and double quotes but accepted CR/LF and other control characters. POSIX pathnames can contain such characters; interpolating them into policy source risks turning a path value into additional policy text.

**Fix added on main:** the SBPL string renderer now rejects C0 controls, DEL, and Unicode line separators before generating a profile. The failure is closed: OASIS refuses to construct that sandbox profile instead of attempting to execute with an ambiguous policy. Regression tests cover writable and masked paths. This is a source-level hardening change; macOS runtime enforcement and the full CI result must still be verified on the resulting commit.

**Comparison note:** Anthropic's public `sandbox-runtime` provides a useful reference for OS-level filesystem and network confinement. OASIS's current sandbox remains a smaller optional implementation and should not be described as feature-equivalent to that runtime until equivalent adversarial and platform tests exist.

## Follow-up hardening: credential masking when the workspace is the home directory

**Finding:** the sandbox credential masker treated the workspace root as an explicit writable-directory grant. If a user selected their home directory as the workspace, the overlap check omitted every credential path beneath it, so sandboxed commands could read those files even though credential masking was enabled. The bubblewrap mount order also placed masks before writable binds, allowing a broad writable bind to hide a mask.

**Fix added on main:** credential masking now distinguishes the workspace root from explicitly added directories, only lets an explicit grant containing a sensitive path opt that path out, and mounts writable roots before overlaying credential masks. A writable child under a credential directory no longer opts the entire parent directory out of masking. Regression tests cover a home-directory workspace, nested writable paths, and bubblewrap mount ordering.

**Verification boundary:** this is source-level hardening until the current main commit's Quality Checks pass; CI cannot establish macOS Seatbelt enforcement by itself, and native macOS sandbox behavior still needs platform-specific runtime tests.

## Follow-up hardening: re-check permissions after PreToolUse rewrites

**Finding:** `authorizeCall()` evaluated the permission policy against model-provided arguments, then accepted `PreToolUse` `updatedInput` and passed the original `allow` decision into execution. A hook could therefore rewrite an explicitly allowed command to a different command without the new arguments being checked against the allow/deny rules. For command execution, the stale allow also set `ruleAllowed`, which bypasses the high-risk command approval gate.

**Fix added on main:** when a `PreToolUse` hook changes tool input, OASIS evaluates the final merged arguments again. A matching deny rule blocks immediately; an explicit ask is preserved; and an allow for the original inputs no longer authorizes a different command by accident. Auto-mode shell classification is re-applied to the final decision. Regression tests cover both fresh approval after an input rewrite and enforcement of a deny rule against the rewritten command.

**Verification boundary:** current main CI is being rerun against the test and source changes. This is a source-level finding/fix, not a penetration-test result. See [open-source security research](OPEN_SOURCE_SECURITY_RESEARCH.md) for the component evaluation and integration constraints.

## Follow-up hardening: fail closed when the requested OS sandbox is unavailable

**Finding:** the single-executable command runner and shell runner could continue after sandbox configuration explicitly enabled isolation but the host could not provide it. They would fall back to ordinary execution with approval, which is not equivalent to the requested containment. The shell path also converted an unavailable-but-enabled sandbox into `null`, losing the user's isolation requirement.

**Fix added on main:** centralized an `assertSandboxAvailable()` guard in the sandbox module and call it before command approval in both command execution paths. The command wrapper also checks it as defense in depth. When sandboxing is explicitly enabled but unavailable, OASIS now refuses to start the command and explains why; the user must either make the sandbox available or deliberately disable it. Regression tests verify the single-executable path, shell path, and direct wrapper fail before approval/execution.

**Verification boundary:** regression tests have been added but must pass in GitHub Actions on the resulting main SHA. Native OS enforcement remains a separate platform-validation requirement.

## Follow-up hardening: free-form shell auto-approval is a separate opt-in

**Finding:** the shell tool accepted arbitrary pipelines, redirections and command chains, yet sandbox availability plus the general `autoAllowCommands` default could auto-approve it without the same argv-based risk analysis. Writable workspace isolation does not protect the user's uncommitted or untracked project files from destructive commands.

**Fix added on main:** OASIS now separates `sandbox.autoAllowCommands` from `sandbox.autoAllowShellCommands`. The former continues to control single-executable argv commands; the latter defaults to false, so free-form shell commands ask for approval unless explicitly opted in, explicitly permitted by a rule, or run under the explicit bypass-permissions mode. A regression test checks that argv auto-approval does not imply shell auto-approval.

**Verification boundary:** the regression must pass on the current main SHA. This is a safer default, not a complete shell parser or a guarantee that all destructive shell behavior can be recognized.

## Cross-platform regression: canonical paths on macOS

**Finding:** portable global skills and global-extension skills compared a canonicalized root (`realpath`, often `/private/var/...` on macOS) with an uncanonicalized target path (often `/var/...`). Legitimate files under a temporary or home directory could be rejected on macOS. Two credential-masking tests also compared canonical result paths with noncanonical temporary paths, causing false failures.

**Fix added on main:** containment checks now compare lexical root-to-target paths first, then independently compare canonical real paths after checking that the target itself is not a symlink. This preserves the symlink-escape guard while accepting macOS path aliases. The sandbox tests compare the real canonical credential path. Cross-platform CI will verify the fix.

