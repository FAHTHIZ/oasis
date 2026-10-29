# UI/UX and real-app brief: implementation audit

**Audit date:** 2026-10-29  
**Repository:** [FAHTHIZ/oasis](https://github.com/FAHTHIZ/oasis)  
**Scope:** Compare `EVA_UI_UX_BRIEF.md` and `EVA_APP_BRIEF.md` against the current default-branch files. This is a source review, not a fresh end-to-end test run.

Legend: **Implemented in source** means a matching code or documentation path exists; it does not mean every OS or user journey has been manually verified. **Partial / verify** means a core piece exists but a requirement, coverage, or release check remains. **Missing** means no matching implementation was found in the inspected paths.

## Website and project front door

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Clear product description and Alpha expectations | Implemented in source | `site/index.html` describes the product and shows Alpha; README now has an Alpha badge. |
| Separate desktop and terminal installation choices | Implemented in source | Homepage has two distinct install cards. |
| Re-check limitations against actual code | Partially done | Homepage acknowledges the VS Code integration and unfinished platform/phone work; continue keeping it synchronized with current code. |
| Larger/accessible muted text and WCAG AA | Partial / automated selected-pair checks added on `app/alpha-readiness-gaps` | Homepage and browser-workspace integrity scripts now calculate WCAG contrast for selected small-text/background pairs; the workspace's dim section/footer labels were brightened. A full visual audit, all states/themes, keyboard/screen-reader checks, and real-device validation remain open. |
| Install → Quick start → User guide link order | Implemented in source | Homepage docs list and README links put the install path first. |
| Root `index.html` versus `site/index.html` | Resolved: they serve different products | Root `index.html` is the installable browser workspace; `site/index.html` is the public marketing homepage. They should not be merged or deleted as duplicates. `scripts/check-site.mjs` validates the app; `.github/scripts/check-public-site.mjs` validates the homepage. |
| Social preview and Open Graph metadata | Implemented in source | `site/index.html` points to `site/assets/oasis-social-preview.svg`, a 1200×630 SVG. |
| Honest search/model-provider privacy note | Implemented in source | Homepage explains the DuckDuckGo fallback and that prompts/code/context go to the configured model provider. |
| Real in-product screenshot near homepage hero | **Missing** | The repository has branded artwork, but no verified screenshot/recording of a real OASIS session was found. Do not label artwork as a product screenshot. |
| Real README screenshot or demo GIF/video | **Missing** | The README banner is brand artwork, not a recorded product session. |
| 60-second demo recording | **Missing** | Needs a real capture of the working product. |

## Desktop app

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Three-path first-run model setup | Implemented in source | Root app has API-key, OmniRoute, and Ollama paths; current status documents the flow. |
| API keys masked and stored via Electron secure storage | Implemented in source | `desktop/main.mjs` uses Electron `safeStorage`, fails closed if encryption is unavailable, and rolls back the previous secret if config persistence fails. Real host/keychain behavior still needs platform validation. |
| Ollama discovery | Implemented in source | `src/web.mjs` exposes a loopback-only local-model discovery endpoint targeting the fixed Ollama localhost API. |
| Safe installation confirmation | Partial / verify | Setup and install flows have approval gates; the full set of missing-dependency prompts still needs journey testing. |
| Chat/terminal split and narrow-screen tabs | Implemented in source | Root app includes split controls, resize handling, and narrow-screen styles. |
| Plain-language approval messages and secret redaction | Implemented in source | `src/approval-language.mjs` is shared by CLI/browser paths; desktop/browser checks cover redaction. VS Code uses the CLI's permission stream, but the full wording should be manually reviewed there. |
| Activity timeline and empty-state starter tasks | Implemented in source | Browser workspace includes a run monitor/event list and three starter prompts. |
| Model/mode/context/cost status and budget warnings | Implemented in source | Terminal status footer includes model, mode, context percentage, cost and budget warnings. Browser usage/status data is available, but complete visual parity needs checking. |
| Checkpoints and one-click undo | Partial / verify | Core snapshots/checkpoints/rewind exist; the desktop UI still needs a full manual test that the last edit can be safely undone from the intended screen. |
| Plain-language settings, help, and copy-details/doctor action | Copy-details implemented on `app/alpha-readiness-gaps`; full journey pending | Desktop startup/workspace errors now offer Copy details / Close. Diagnostic text is redacted before display/copy and clipboard failure gives a manual-copy fallback. The full desktop error journey still needs host testing; the CLI doctor and browser settings remain separate paths. |
| Automatic desktop updates | **Missing** | `electron-updater` is not a dependency and no updater integration was found. Do not promise automatic updates. |
| Crash recovery screen | **Implemented on `app/alpha-readiness-gaps`; app-level verification pending** | `desktop/main.mjs` now handles Electron renderer termination and loads a recovery screen with a restart link and escaped reason/exit-code details. `test/desktop-crash-screen.test.mjs` covers the helper's output and loopback-only restart target; the full desktop crash/restart journey still needs CI and host testing. |
| Clean-machine installer validation | Partial / verify | Packaging exists, but unsigned installers and first-run/update/uninstall journeys require actual Windows, macOS, and Linux testing. |

## Terminal

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Three-path first-run setup | Implemented in source | The user guide documents API key, gateway, and local model choices. |
| Shared plain-language approval wording | Implemented in source | `src/approval-language.mjs` supplies structured messages and risky-action warnings. |
| Status footer, context/cost/budget warnings | Implemented in source | `footerFor` in `src/terminal-ui.mjs`. |
| Friendly errors with next step and doctor hint | Partial / verify | Doctor and diagnostics exist, but every error path has not been audited for plain-language recovery guidance. |
| Diffs with filenames, +/- counts and non-colour markers | Partial / verify | Diff rendering exists; verify all display paths use visible plus/minus markers and line counts in no-colour mode. |
| Calm progress and animation opt-out | Partial / verify | `OASIS_NO_ANIMATION=1` is respected by startup animation; tool-by-tool progress stability needs terminal testing. |
| Grouped help and startup tips | Implemented in source | Help/command discovery and rotating startup tips exist; `OASIS_NO_TIPS=1` or `OASIS_TIP=off` disables tips. |
| Screen-reader-friendly mode | Partial / verify | Colour/animation can be disabled, but a complete screen-reader-specific experience was not verified. |
| Windows/macOS/VS Code/tmux/Termux matrix | **Not fully verified** | Current status says Termux is experimental for PTY; cross-terminal width and lifecycle checks remain a release gate. |

## Browser workspace and phone

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Empty-state examples, approval cards, run monitor | Implemented in source | Root `index.html` includes the starter tasks, approval card, and monitor event UI. |
| Theme switch and remembered preference | Implemented in source | Theme/settings hooks exist in the browser app; verify persistence and keyboard navigation manually. |
| 390px layout and large touch targets | Partial / verify | Responsive CSS and a 390px breakpoint exist; this is not a substitute for real-device testing. |
| Clear connection-scope banner | Implemented in this pass | Agent view now explains that the runtime listens on this computer by default, remote access requires explicit server options, and the runtime token must not be shared. This is a static explanation, not live detection of the actual bind address. |
| Desktop/phone screenshots for every state | **Missing** | No verified capture set for empty state, chat, approval, error, and settings was found. |
| Secure QR pairing and paired-device management | **Missing** | No dedicated pairing/token/revocation flow was found. |
| Phone threat model | Added in this pass | See [Phone connection security note](PHONE_CONNECT_SECURITY.md). This is a design gate, not implementation. The core safety brief must be completed and reviewed before phone pairing work begins. |

## VS Code integration

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Chat panel, selection context, diff review | Implemented in source | `ide/vscode/src/chat-view.js` and `ide/vscode/src/extension.js`. |
| Plain-language approvals | Improved; manual verification remains | Browser card now says “OASIS needs your permission,” “Allow once,” and “Deny”; reusable approvals explicitly say they apply for this session. VS Code cards add a cautious destructive-action warning, a clear deny instruction, keyboard-focus styling and a minimum 36px button height. The shared approval backend still enforces the actual decision; risk highlighting is only a visual heuristic. Manual review is still required. |
| Friendly missing-CLI error | Implemented in this pass | `ide/vscode/src/chat-process.js` now explains how to install OASIS or configure `oasis.command`; a focused regression test was added. |
| Changelog | Implemented in this pass | `ide/vscode/CHANGELOG.md`. |
| Marketplace icon and screenshots | **Partial / missing** | Activity-bar SVG exists, but a marketplace-ready PNG extension icon and real chat/diff/selection screenshots are still outstanding. |

## Contribution and documentation

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Five-minute quickstart | Implemented in source | `docs/QUICKSTART.md` exists and covers desktop, provider setup, first task, and common problems. Follow it verbatim on clean machines before release. |
| Issue templates | Implemented in source | Bug, feature idea, and question templates already exist under `.github/ISSUE_TEMPLATE/`. |
| PR template | Implemented in source | `.github/PULL_REQUEST_TEMPLATE.md` already exists. |
| Warm contribution guide | Implemented in source | `CONTRIBUTING.md` describes the project as an alpha hobby project and documents checks. |
| GitHub Discussions | **Unverified** | Repository Discussions availability/settings were not confirmed during this source audit. |
| Demo GIF/video | **Missing** | Needs a real capture, not a mockup. |

## Efficiency and coding quality

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Verify before saying "done" | Partial / verify | Regression/evaluation tooling exists; expand task coverage and verify every final claim against executed checks. |
| Read before edit / re-read changed files | Partial / verify | Agent tool and workflow support exist, but full race/change-before-write coverage was not established by this brief audit. |
| Trim long tool output | Partial / verify | Several tool summaries are bounded; confirm all long-output paths preserve full logs while reducing model context. |
| Idle compaction with token-savings note | Partial / verify | Context compaction exists, but the exact idle-trigger and user-facing saved-token note were not verified. |
| Cheap-model routing, budget limit, fallback model | Partial / verify | Cost/budget features exist; automatic model routing and fallback semantics need explicit tests and user-facing documentation. |
| Weak/free model reliability | Partial / verify | Retry/provider paths exist; a reproducible local-model benchmark is still required. |
| "What I'm unsure about" at end of large tasks | Partial / verify | Prompting/evaluation expectations exist; verify this is enforced consistently in final responses. |

## Work completed during this audit

- Added `ide/vscode/CHANGELOG.md`.
- Improved VS Code startup failures for missing or non-executable OASIS commands, including clear next steps and an `oasis doctor` hint for unexpected errors.
- Clarified VS Code permission cards with “Allow once” / “Deny”, a review-before-approval reminder, and a conservative red warning for likely destructive requests; added keyboard-focus styling.
- Added actionable guidance for nonzero VS Code CLI exits, filtered stack frames from the user-facing summary, and added focused regression tests in `test/vscode-chat-process.test.mjs`.
- Aligned browser approval labels with the same one-time allow/deny wording and explicitly scoped reusable approvals to the current session.
- Added `docs/PHONE_CONNECT_SECURITY.md` and clarified that explicit LAN/TLS options exist today but do not constitute secure phone pairing.
- Added an Alpha badge to the README and corrected the Apache license badge's alt text.
- Added a connection-scope/token-safety note to the browser Agent view and made the integrity check require it.
- On `app/alpha-readiness-gaps`, added a desktop renderer-crash recovery screen and focused tests. The crash-screen and error-dialog helper tests passed **7/7** in a local temporary harness; the complete repository suite and Electron crash/restart journey have not been run here.
- Added WCAG contrast-ratio checks for selected public-homepage and browser-workspace text colors, and brightened two low-contrast workspace labels. The full public-site/app checks have not yet been run from the repository.
- Added a reusable desktop error dialog with **Copy details** and **Close** choices. Error text is redacted before it is displayed or copied; if clipboard access fails, OASIS explains how to copy manually. Focused tests were added but have not yet been run as part of the repository suite.

## Verification limits

The repository can be read and updated through GitHub, but this runtime could not clone the repository to run tests locally because it could not resolve `github.com`. GitHub Actions caught a syntax error in an earlier VS Code exit-message commit (`Unexpected identifier 'oasis'` from a nested template-literal backtick); the wording was corrected in commit `6ff224bc`. The subsequent quality run was still queued at the last status check, so the latest code is **not yet confirmed green**. Re-check [GitHub Actions](https://github.com/FAHTHIZ/oasis/actions) for the current `main` run, then do a live VS Code review. Do not treat source edits as test passes.


## Follow-up branch status — `app/alpha-readiness-gaps`

This branch adds the missing desktop renderer-crash recovery path. It is intentionally separate from the verified default-branch snapshot; do not treat the change as shipped until the repository checks pass and the recovery flow is exercised in a packaged or development Electron app. The isolated crash-screen and error-dialog helper tests passed **7/7** in a local temporary harness; this is not a substitute for `npm run check`, the clean-environment suite, or actual Electron crash/restart testing.
