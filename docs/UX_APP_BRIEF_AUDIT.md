# UI/UX and real-app brief: implementation audit

**Audit date:** 2026-10-30  
**Repository:** [FAHTHIZ/oasis](https://github.com/FAHTHIZ/oasis)  
**Scope:** Compare `EVA_UI_UX_BRIEF.md` and `EVA_APP_BRIEF.md` against the current default-branch files. This is a source review, not a fresh end-to-end test run.

Legend: **Implemented in source** means a matching code or documentation path exists; it does not mean every OS or user journey has been manually verified. **Partial / verify** means a core piece exists but a requirement, coverage, or release check remains. **Missing** means no matching implementation was found in the inspected paths.

## Website and project front door

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Clear product description and Alpha expectations | Implemented in source | `site/index.html` describes the product and shows Alpha; README now has an Alpha badge. |
| Separate desktop and terminal installation choices | Implemented in source | Homepage has two distinct install cards. |
| Re-check limitations against actual code | Partially done | Homepage acknowledges the VS Code integration and unfinished platform/phone work; continue keeping it synchronized with current code. |
| Larger/accessible muted text and WCAG AA | Partial / verify | Muted text is brighter than the earlier brief's example, but no contrast-checker result or full accessibility audit was found. |
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
| Three-path first-run model setup | Implemented in source; automated route coverage added | API, OmniRoute and Ollama choices expose a selected state and route-specific next steps. Browser E2E selects each route, checks the provider preset/status, and captures desktop plus 390px states. Ollama discovery still requires a real local Ollama installation for hardware validation. |
| API keys masked and stored via Electron secure storage | Implemented in source | `desktop/main.mjs` uses Electron `safeStorage`, fails closed if encryption is unavailable, and rolls back the previous secret if config persistence fails. Real host/keychain behavior still needs platform validation. |
| Ollama discovery | Implemented in source | `src/web.mjs` exposes a loopback-only local-model discovery endpoint targeting the fixed Ollama localhost API. |
| Safe installation confirmation | Partial / verify | Setup and install flows have approval gates; the full set of missing-dependency prompts still needs journey testing. |
| Chat/terminal split, narrow-screen tabs and Runs & changes utility | Implemented in source; same-revision browser CI pending | Root app keeps the resizable chat/terminal split, adds a right-side Runs & changes tab backed by the existing saved-run/diff view, and preserves phone Chat/Terminal switching. Browser E2E covers desktop and 390px utility switching with axe checks. |
| Plain-language approval messages and secret redaction | Implemented in source | `src/approval-language.mjs` is shared by CLI/browser paths; desktop/browser checks cover redaction. VS Code uses the CLI's permission stream, but the full wording should be manually reviewed there. |
| Activity timeline and empty-state starter tasks | Implemented in source | Browser workspace includes a run monitor/event list and three starter prompts. |
| Model/mode/context/cost status and budget warnings | Implemented in source | Terminal status footer includes model, mode, context percentage, cost and budget warnings. Browser usage/status data is available, but complete visual parity needs checking. |
| Checkpoints and one-click undo | Partial / verify | Core snapshots/checkpoints/rewind exist; the desktop UI still needs a full manual test that the last edit can be safely undone from the intended screen. |
| Plain-language settings, help, and copy-details/doctor action | Partial / verify | CLI doctor and browser settings exist; a complete desktop-friendly error/help journey with a copy-details action was not verified. |
| Automatic desktop updates | **Missing** | `electron-updater` is not a dependency and no updater integration was found. Do not promise automatic updates. |
| Crash recovery screen | **Missing / unverified** | No explicit renderer/background-process crash recovery UI was found in `desktop/main.mjs`. |
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
| 390px layout and large touch targets | Implemented in source; CI verification pending | Chat-first workspace has dedicated 780px and 390px rules, 44px phone controls, a no-horizontal-overflow assertion, and axe contrast scans for chat, terminal, provider settings and first-run. This is not a substitute for real Android device/Termux PTY testing. |
| Clear connection-scope banner | Implemented in this pass | Agent view now explains that the runtime listens on this computer by default, remote access requires explicit server options, and the runtime token must not be shared. This is a static explanation, not live detection of the actual bind address. |
| Desktop/phone screenshots for every state | CI capture coverage added; artifact verification pending | Browser E2E captures empty state, connected chat, connection error, approval, terminal, Runs & changes, provider settings and first-run across desktop/390px. Actual screenshot artifacts are not considered verified until the same-revision browser workflow passes and publishes them. |
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

## Current implementation snapshot

- The public homepage and README identify OASIS as an alpha open-source AI coding agent, separate desktop installation from the developer CLI, explain the configured model/search provider boundary, and link to the Install/Quick start/User guide path.
- `site/assets/oasis-social-preview.svg` is a custom 1200×630 social card, with Open Graph/Twitter metadata and public-site regression checks. It is branded artwork, **not** a real product screenshot.
- The root workspace contains a local-only-by-default connection notice and warning not to share runtime tokens. This is explanatory copy, not live verification of network binding.
- The browser approval card uses “Allow once” and “Deny”; the reusable approval label states that it applies for the current session. The shared server-side approval handler remains the enforcement point.
- VS Code approval cards include an instruction to review the requested action, a conservative visual warning for likely destructive requests, and keyboard-focus styling. Nonzero CLI exits now receive a short next-step message and an `oasis doctor` hint; focused test cases cover the new helper behavior.
- `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `docs/QUICKSTART.md`, `CONTRIBUTING.md`, and `ide/vscode/CHANGELOG.md` already exist. The changelog now records the approval and error-message improvements.
- `docs/PHONE_CONNECT_SECURITY.md` already exists as a design gate. Phone pairing itself remains unimplemented and must not start until the user has read and reviewed the security note.
- `index.html` is the app workspace; `site/index.html` is the separate public homepage. They are not duplicate files and must not be merged or deleted as a cleanup shortcut.

## Verification limits

The repository can be read and updated through GitHub, but this runtime could not clone the repository to run tests locally because it could not resolve `github.com`. GitHub Actions caught a syntax error in an earlier VS Code exit-message commit (`Unexpected identifier 'oasis'` from a nested template-literal backtick); the wording was corrected in commit `6ff224bc`. The subsequent quality run was still queued at the last status check, so the latest code is **not yet confirmed green**. Re-check [GitHub Actions](https://github.com/FAHTHIZ/oasis/actions) for the current `main` run, then do a live VS Code review. Do not treat source edits as test passes.
