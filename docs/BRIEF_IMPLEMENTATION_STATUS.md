# Implementation status for the app and UI/UX briefs

**Checked:** 29 October 2026  
**Scope:** Compare `EVA_APP_BRIEF.md` and `EVA_UI_UX_BRIEF.md` with source files and the checked-in CI configuration. This is a source review, not a claim that all journeys were manually tested. “Implemented” means visible in code or covered by an existing automated check; it does not imply full cross-platform release readiness.

## Product and first-run

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Desktop first-run choices: API key, free gateway, local model | **Implemented in part** | Browser/app first-run UI exposes API, OmniRoute and Ollama choices. Desktop key storage uses Electron `safeStorage`; clean-machine install and all provider-account flows still need manual validation. |
| Mask API key and encrypt desktop key at rest | **Implemented** | `desktop/secure-secrets.mjs`, `desktop/main.mjs`; existing public-site integrity assertions check encrypted storage and rollback. |
| Test provider connection before saving | **Implemented** | Quick start describes a tool-capability check; verify each live provider/account separately. |
| One-click OmniRoute setup from desktop | **Partial** | Terminal setup exists; a fully self-contained desktop button is not established by this audit. |
| Discover local Ollama models | **Implemented** | Browser runtime exposes loopback-only model discovery. |
| “Install it for me” with exact command and approval | **Partial / not established** | Install and package tools are present, but the complete beginner-facing desktop flow was not confirmed. |
| Chat + terminal side-by-side; narrow window uses tabs | **Implemented in browser workspace** | Root `index.html`, split/tabs and responsive E2E checks. Real desktop-window and phone-device review remains open. |
| Timeline, empty chat examples, command palette, run monitor | **Implemented** | Root `index.html`; browser E2E exercises key flows. |
| Model/mode/context/cost and budget warnings | **Partial across surfaces** | Terminal status supports model, mode, context, cost and 50%/90% budget warnings. Browser run monitor shows usage totals; a single consistent configurable budget bar in every surface was not established. |
| Checkpoints and recovery | **Implemented, lifecycle limits remain** | Checkpoints/rewind and interrupted-run history exist. Saved records do not restart dead worker processes or restore pending approvals. |
| Automatic desktop updates | **Not implemented** | No `electron-updater` integration was found. Requires release-channel/signature/update failure design and package/licence/audit review. |
| Crash recovery screen and full reset/settings journey | **Partial / not established** | Startup errors and settings exist, but a dedicated worker-crash screen and tested reset-everything path were not confirmed. |
| Signed installers / clean-machine install-update-uninstall | **Open** | Packaging workflows exist; current documentation says installers are unsigned. Build success alone is not first-run or uninstall proof. |

## Website and README

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Clear headline, Alpha badge and desktop-vs-terminal choices | **Implemented on public homepage** | `site/index.html`; desktop path is separated from the developer CLI path. |
| Current license and correct limitations | **Updated** | Public homepage reflects Apache-2.0 and acknowledges the VS Code-family integration and known platform boundaries. |
| Install, Quick start and User guide first | **Implemented** | Public homepage and README navigation updated. |
| Privacy note for search/model providers | **Implemented** | Public homepage and README explain the DuckDuckGo fallback, configurable search provider, and that prompt/context go to the chosen model provider. |
| Social preview and Open Graph metadata | **Partial** | A 1200×630 SVG and Open Graph/Twitter metadata were added. Rendering in GitHub, X, Discord and other preview crawlers has not yet been verified. |
| Real product screenshot near top of public homepage / README | **Open** | CI produces real desktop and 390px browser screenshots, but a permanent screenshot/short bug-fix demo is not yet embedded in the public front door. |
| Small-text contrast checked against WCAG AA | **Partial** | Homepage hero-note and footer text were enlarged/lightened. No complete automated/manual contrast audit was run. |
| Root `index.html` vs `site/index.html` duplication | **Not duplicates** | Root `index.html` is the browser workspace application; `site/index.html` is the marketing homepage. `scripts/check-site.mjs` validates the application; `.github/scripts/check-public-site.mjs` validates the public site. Do not merge or delete either. |

## Terminal

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Guided setup; status footer; grouped help; startup tips | **Implemented** | Documented in `docs/CURRENT_STATUS.md` and reflected in terminal UI implementation. |
| Calm progress and `OASIS_NO_ANIMATION=1` | **Implemented** | `src/terminal-ui.mjs` respects no-animation/CI/dumb-terminal conditions. |
| `NO_COLOR` and screen-reader-related output | **Partial** | Terminal line editor has no-colour/screen-reader handling; full end-to-end screen-reader mode still needs testing. |
| Human-readable errors and permission prompts everywhere | **Partial** | Human-readable prompts and redaction exist, but consistency of wording across terminal, browser and IDE needs focused review. |
| Diff filenames, +/- counts, colour-independent markers | **Partial** | Diffs exist; full accessibility formatting audit and code-highlight add-on are not established. |
| Windows/macOS/tmux/VS Code terminal/Termux manual testing | **Open** | CI covers Linux PTY and cross-platform security tests, not a real-device/real-terminal usability matrix. |

## Browser workspace

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Empty-state examples, persistent theme, responsive chat/terminal | **Implemented** | Root `index.html` and browser E2E checks. |
| Activity/run timeline and cancellation/approval safety | **Implemented in core flows** | Run monitor and automated tests cover event history, denial and cancellation; consistency of approval wording remains open. |
| 390px E2E screenshots | **Automated coverage exists** | Workflow uploads desktop and phone-width screenshots as artifacts; review and real-phone testing are still needed. |
| 44px tap targets and keyboard-only full journey | **Not fully verified** | Responsive styling exists; no complete touch-target/keyboard audit was run. |
| Clear “Local only” trust banner | **Partial / verify exact copy** | Runtime is local-hosted by default; explicit, always-visible banner wording needs a focused check. |
| Secure phone pairing | **Not implemented** | Design note exists at `docs/PHONE_CONNECT_SECURITY.md`. Do not start implementation until the user has read it and the opt-in, token, revocation, TLS and approval requirements are agreed. |

## VS Code-family integration

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Native extension, chat, selection context, diff review, diagnostics | **Implemented** | `ide/vscode/`; supports VS Code and compatible forks. |
| CHANGELOG | **Implemented** | `ide/vscode/CHANGELOG.md`. |
| Friendly missing-CLI and consistent plain-language approvals | **Partial / needs manual review** | Core extension exists; verify the missing-command journey and the exact risk wording in a live VS Code session. |
| Marketplace PNG icon and real screenshots | **Open** | An activity-bar SVG exists, but a marketplace-ready PNG icon and marketplace screenshots are not prepared. |
| Publish-ready extension validation | **Open** | Needs package validation, real VS Code install/update test and marketplace-specific asset checks. |

## Community and quality

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Quick start and warm contributing guide | **Implemented** | `docs/QUICKSTART.md` and `CONTRIBUTING.md`. |
| Bug, idea and question templates; PR checklist | **Implemented** | `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`. |
| GitHub Discussions and good-first-issue labels | **Not verifiable from repository files alone** | These are repository settings/labels; check GitHub settings and label list directly. |
| 60-second demo video/GIF | **Open** | No permanent demo was established in this audit. |
| Test suite and CI | **Implemented; new commits still need green CI** | `.github/workflows/quality.yml` covers Node 22/24/26, clean-environment tests, Linux PTY, cross-platform security and browser E2E. The current edits have not yet been locally run in this environment. |
| Proof-before-done / post-edit verification | **Implemented with limits** | Agent verification gate and regression tests exist; the coding benchmark remains too small to establish broad quality parity. |
| Read-before-edit and refresh after file changes | **Partial / keep auditing** | Some safe edit flows re-read before patching; prove this across all edit routes and concurrent changes. |
| Trim long output, idle compaction, cheap model routing, fallback model | **Partial** | Bounded output, context compaction and budgets exist. Full idle-triggered compaction, automatically routed cheap models and all requested CLI flags need individual source/test verification. |
| Benchmark real repository-level outcomes | **Open** | Current fixture set is a regression suite, not a representative comparative coding benchmark. |

## Recommended order

1. Finish and run the public-site/README regression tests; then attach a real product screenshot and verify social preview rendering.
2. Complete approval/error wording across browser, terminal and VS Code, with tests that prove destructive actions can be denied and cancellation prevents side effects.
3. Add and verify the marketplace PNG icon/screenshots; manually test missing-CLI and diff-review journeys.
4. Run clean-machine desktop installation, first-run, update/uninstall and crash-recovery checks before adding auto-update.
5. Read and explicitly sign off the phone threat note before implementing phone pairing.
6. Expand controlled coding evaluations and close agent-reliability gaps using measured outcomes, not feature-count claims.

**Verification note:** a Git clone and local test run were attempted in this environment, but network access to GitHub was unavailable. Do not treat that as a passed test. Check the latest Actions run for the current `main` commit after each implementation change.
