# OASIS repository maintenance

This document is the canonical record for repository layout, intentional copies, duplicate-review decisions and guarded branch cleanup. It replaces the separate branch audit, hygiene guide and duplicate-sweep notes.

## Canonical ownership

| Path | Purpose |
|---|---|
| `src/` | Runtime modules and service boundaries. Keep security, storage, process, network, provider, session and integration services independently testable. |
| `test/` | Focused subsystem and integration regression tests. Keep tests near their behavior boundary; similar filenames do not prove duplicate coverage. |
| `index.html`, `src/web.mjs`, `assets/` | Local browser workspace/PWA. |
| `site/` | Separate static public landing page deployed through GitHub Pages. |
| `desktop/` | Electron host, secure-secret bridge and desktop failure surfaces. |
| `ide/vscode/` | VS Code-compatible extension and chat bridge. |
| `skills/` | Shared portable Agent Skills. |
| `plugins/` | Reviewed example/plugin packages and catalog. |
| `evals/tasks/` | Frozen task prompts, snapshots, reference patches and independent verifiers. |
| `evals/snapshots/` | Immutable evaluation repository snapshots. Never silently replace with live source. |
| `docs/` | Canonical product, architecture, release, security, benchmark and user documentation; supporting research lives under `docs/research/`. |
| `.github/workflows/`, `.github/scripts/` | CI, release, public-site and guarded branch-maintenance automation. |

## Intentional exact-content copies

The repository-wide blob scan found only a small set of byte-identical groups. They are deliberate, not cleanup targets:

- `assets/oasis-icon.svg`, `assets/oasis-mark.svg` and `assets/oasis-social-preview.svg` have matching copies under `site/assets/`. The static site is deployed as a self-contained directory, so its asset paths must exist at that root.
- A few shared skill files match their copies under `evals/snapshots/oasis-main/skills/`. Snapshot copies are frozen baselines; source-skill improvements must not rewrite historical benchmark inputs.
- The 33 `evals/tasks/*/repo/BASE_SNAPSHOT` pointer files intentionally share one tiny blob. Each pointer is task metadata referring to a reusable named snapshot, not duplicate source code.
- Root `index.html` and `site/index.html` are not duplicates: one is the app workspace, the other the public landing page.

Before removing any same-content file, check its deployment root, task snapshot, importer, package manifest and tests. Do not consolidate copies merely because their bytes match.

## Branch cleanup receipt

The guarded cleanup workflow retired **9 exact audited/superseded branch refs** in its successful October 31 cleanup pass ([run 41174518215](https://github.com/FAHTHIZ/oasis/actions/runs/41174518215)). A subsequent pass on [run 41174604382](https://github.com/FAHTHIZ/oasis/actions/runs/41174604382) found no further safe deletions and preserved 11 divergent branches. The latest check on audited main snapshot `51590f2f27e9378724e8325dc954ff1ac3a0f313` also passed cleanup and preserved all 11 remaining refs ([run 41175743360](https://github.com/FAHTHIZ/oasis/actions/runs/41175743360)).

**Exact retired refs:**

- `fix/omniroute-setup-default-20261027`
- `fix/preserve-current-provider-on-setup-20261027`
- `fix/safety-part-1-completion`
- `ci/gate1-branch-validation`
- `ci/gate1-corrected-integrity-check`
- `fix/gate1-optional-terminal`
- `fix/gate1-site-mark-assertion`
- `fix/gate1-static-asset-routes`
- `test/gate1-browser-and-asset-smoke`

**Remaining refs preserved because their content is non-equivalent or not fully verified:**

- `app/alpha-readiness-gaps`
- `app/empty-chat`
- `app/first-run`
- `app/status-activity`
- `app/workspace-layout`
- `cli/getting-started`
- `cloud-engine/maturity-foundation`
- `fix/phase-0-finish-plan-20261030-sync`
- `fix/phase-0-finish-plan-20261030`
- `ux/chat-first-step-0`
- `ux/chat-first-step-1`

No preserved branch was merged wholesale into `main`. These refs remain available for deliberate source review and selective porting.

## Retirement rules

The cleanup action in `.github/workflows/cleanup-merged-branches.yml` runs only on `main`. It preserves the default/protected branches and branches used by open pull requests. A non-default branch may be retired only when exact evidence proves one of the following:

1. Its exact head was merged into the default branch.
2. It is strictly behind the default branch with zero unique commits.
3. Its exact audited head is explicitly listed as superseded and all required canonical replacement paths exist on `main`.
4. Every net changed-file state is byte-identical to the default tree.

Incomplete API responses, oversized diffs, non-equivalent file states and unexpected errors fail closed. The workflow log—not a candidate list or ancestry count—is the deletion receipt. Recheck exact heads before any manual operation.

## Historical bug/duplicate decisions

The October 29 duplicate sweep recorded three maintenance fixes:

- Updated the channel-redaction test expectation to match the runtime's secret-specific redaction marker.
- Removed repeated app-integrity markers from `scripts/check-site.mjs` without reducing the actual assertions.
- Replaced a duplicate desktop persistence assertion with coverage for the distinct non-desktop fallback path.

These are historical change notes, not current verification evidence. Use the latest same-SHA Quality and release workflow results.

## Maintenance discipline

- Keep direct source modules small and separated by responsibility when that separation improves security or testability.
- Keep subsystem tests focused; consolidate only when two files are genuinely one conceptual suite and combined failure output remains diagnosable.
- Do not merge frozen eval fixtures, generated public-site assets or security boundaries just to lower a file count.
- Run `npm run check` after documentation/code changes; for releases, require all applicable same-commit CI workflows.
- Update this document only when canonical ownership, duplicate decisions or actual cleanup receipts change.


## Public site and repository identity

The static public landing page lives in `site/`. The root `index.html` is the local browser workspace; these two files have different owners and must not be merged. The Pages workflow in `.github/workflows/pages.yml` validates the site and deploys only `site/`. Deployment and repository-metadata updates are separate from pull-request validation and may be skipped when the required repository secret is absent.

The intended public identity is:

- Product name: **OASIS**
- Primary tagline: **Code. Automate. Flourish.**
- Description: Open-source, local-first AI coding agent and developer workspace.
- License: Apache-2.0.

Keep release, download, quality and benchmark badges tied to real published artifacts or current evidence. Search metadata and social previews do not guarantee indexing, traffic or ranking. Repository administration credentials belong only in GitHub Actions secrets; never commit or paste them into documentation.

For the logo, color tokens and interface rules, see [Brand](BRAND.md). For user-visible product claims, the README and [Project plan](PROJECT_PLAN.md) are authoritative.
