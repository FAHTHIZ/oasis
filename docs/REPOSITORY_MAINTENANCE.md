# OASIS repository maintenance

This document is the canonical record for repository layout, intentional copies, duplicate-review decisions and guarded branch cleanup. It replaces the separate branch audit, hygiene guide and duplicate-sweep notes.

## Canonical ownership

| Path | Purpose |
|---|---|
| `src/` | Shared runtime modules and service boundaries. The code is currently organized as top-level domain modules; use [the source map](../src/README.md) before adding or extracting modules. |
| `test/` | Focused subsystem and integration tests. The current top-level `test/*.test.mjs` pattern is intentional; see [the test map](../test/README.md) before changing paths or discovery rules. |
| `index.html`, `src/web.mjs`, `assets/`, `manifest.webmanifest`, `sw.js` | Connected local browser workspace/PWA shell, local API surface, styles, shared app assets, manifest and service worker. |
| `site/` | Separate static public landing page deployed through GitHub Pages. |
| `desktop/` | Electron host, secure-secret bridge and desktop failure surfaces. |
| `ide/vscode/` | VS Code-compatible extension and chat bridge. |
| `evals/tasks/` | Frozen task prompts, snapshots, reference patches and independent verifiers. |
| `evals/snapshots/` | Immutable evaluation repository snapshots. Never silently replace with live source. |
| `bench/` | Focused performance and subsystem benchmark scripts; benchmark outputs are evidence, not product claims by themselves. |
| `plugins/` | Reviewed example/plugin packages and catalog. |
| `skills/` | Shared portable Agent Skills. |
| `scripts/` | Installers, environment checks, packaging helpers, local maintenance scripts, and developer utilities. |
| `.github/workflows/`, `.github/scripts/` | CI, release, public-site and guarded branch-maintenance automation. |
| `docs/` | Canonical product, architecture, release, security, benchmark and user documentation; release notes live under `docs/releases/`, supporting research under `docs/research/`. |
| `package.json`, lockfile | Package identity, Node engine floor, dependencies, export surface, scripts, and desktop build configuration. Keep these in sync with release and test contracts. |
| Root `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` | Public entry point, user-facing history, legal terms, vulnerability reporting, and contribution contract. Keep the root concise; detailed guidance belongs under `docs/`. |



## Release-candidate handling

The current package version is `1.0.0` with Release Candidate 1 metadata. Its `oasisRelease` metadata identifies Release Candidate 1 on `main`; it is not a Git tag, GitHub Release, or stable installer channel. The stable installer intentionally ignores prerelease tags and continues to resolve the latest stable semantic-version tag.

The desktop workflow builds artifacts on normal pushes, but publishing now requires an explicit workflow dispatch with `publish_release: true`. Tags containing a prerelease suffix (for example `v1.0.0`) must be published with GitHub's prerelease flag and must not be marked latest. The final `v1.0.0` release may be marked latest only after the full same-commit qualification checklist passes.

## Source and test organization

The current root-level layout is deliberate: the runtime is a single Node package with shared entry points and many independently imported modules. Do not create an `apps/` or `packages/` monorepo split, move all runtime modules into speculative folders, or relocate test files just to make the tree look more conventional. Those moves would affect relative imports, package file lists, scripts, test discovery, bundling, install paths, and plugin loaders.

Use the source and test maps to identify existing domain boundaries. The safe path is incremental: extract a tested responsibility, keep a compatibility re-export when needed, update all importers and packaging lists, and run the complete same-commit quality matrix. A broad directory migration is a separate engineering project and should have a dependency map and compatibility test before the first move.

## Intentional exact-content copies

The repository-wide blob scan found only a small set of byte-identical groups. They are deliberate, not cleanup targets:

- `assets/oasis-icon.svg`, `assets/oasis-mark.svg` and `assets/oasis-social-preview.svg` have matching copies under `site/assets/`. The static site is deployed as a self-contained directory, so its asset paths must exist at that root.
- A few shared skill files match their copies under `evals/snapshots/oasis-main/skills/`. Snapshot copies are frozen baselines; source-skill improvements must not rewrite historical benchmark inputs.
- The 33 `evals/tasks/*/repo/BASE_SNAPSHOT` pointer files intentionally share one tiny blob. Each pointer is task metadata referring to a reusable named snapshot, not duplicate source code.
- Root `index.html` and `site/index.html` are not duplicates: one is the app workspace, the other the public landing page.

Before removing any same-content file, check its deployment root, task snapshot, importer, package manifest and tests. Do not consolidate copies merely because their bytes match.

## Branch state and cleanup receipt

At the inspected runtime snapshot `7927275a0edefd4e6c791a5774fd82eb13e7ec62`, and again at the documentation snapshot `4e48392f38748f4ade4c21ef023ae9a063245670`, the GitHub branches endpoint returned exactly one branch: `main`. This confirms that the former development refs listed in older audit notes are no longer present. Do not use those historical names as active branches or assume they remain recoverable.

The guarded cleanup workflow completed successfully for the runtime audit snapshot: [run 41267442561](https://github.com/FAHTHIZ/oasis/actions/runs/41267442561). The documentation snapshot also passed cleanup: [run 41267932303](https://github.com/FAHTHIZ/oasis/actions/runs/41267932303). Earlier cleanup receipts are retained as history:

- [run 41174518215](https://github.com/FAHTHIZ/oasis/actions/runs/41174518215) retired 9 exact audited/superseded refs.
- [run 41174604382](https://github.com/FAHTHIZ/oasis/actions/runs/41174604382) found no further safe deletions and preserved 11 divergent refs at that time.
- [run 41175743360](https://github.com/FAHTHIZ/oasis/actions/runs/41175743360) also preserved those 11 refs at its older snapshot. They have since been removed; the current branch listing is authoritative.

The current working policy is main-only for direct maintenance unless the repository owner deliberately changes that policy. The cleanup workflow is not permission to remove unreviewed work: it must prove exact-head safety and fail closed.

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

## Modularization and migration rules

The repository is feature-rich, but several implementation files are large enough to make review and change isolation harder. Do not respond with a one-shot directory rename or a mechanical file split. Refactor along tested responsibility boundaries, in small main-only commits.

### Runtime modules

- Keep the existing public entry points and import paths working while extracting internal domain modules. In particular, treat `src/agent.mjs`, `src/cli.mjs`, `src/tools.mjs`, `src/slash.mjs`, and `src/web.mjs` as high-risk orchestration surfaces, not candidates for blind splitting.
- Extract cohesive subsystems behind narrow interfaces: provider adapters; session/context lifecycle; tool definitions versus execution; permission/risk policy; process/PTY lifecycle; verification; integrations; and transport/API handlers.
- Preserve dependency direction: domain logic must not import CLI, browser, Electron or editor presentation code. Adapters may depend on domain contracts; avoid circular imports and hidden global state.
- Keep security decisions in one enforcement path. A refactor must not create an alternate path that bypasses workspace validation, approval policy, redaction, execution limits, or audit events.
- Preserve the current public exports, CLI commands, configuration keys, state formats and plugin interfaces unless an intentional compatibility change is separately designed and documented.

### Browser workspace

- The root `index.html` is the connected browser workspace; `site/index.html` is a separate public landing page. Never merge or conflate them.
- Extract browser behavior by responsibility (for example activity rendering, chat/session UI, approvals, settings, terminal, and workspace utilities) while retaining explicit initialization order and a small, documented bridge to shared state.
- Prefer external scripts/styles with clear ownership over a growing inline application. Keep static asset allowlists, cache versioning, offline behavior, CSP assumptions, and `scripts/check-site.mjs` in sync when assets move.
- Do not duplicate runtime policy in browser code. The browser is a presentation client; the authenticated local API and shared runtime own execution and permission decisions.

### Tests, evaluations, and documentation

- The current test command uses the top-level glob `test/*.test.mjs`. Moving tests into nested folders requires an explicit test-discovery update and proof that no tests were dropped from CI.
- Organize tests by behavior and fixtures, not by arbitrary alphabetic buckets. Keep adversarial security regressions close to the subsystem they protect.
- Never move or regenerate frozen evaluation snapshots as part of a refactor. Validate fixture quarantine and the independent task verifiers after any test/eval path change.
- `docs/ARCHITECTURE.md` owns the system map and source map. Update it when module ownership or runtime boundaries actually change; do not create competing architecture inventories.
- `docs/USER_GUIDE.md` remains at its stable path while the new [user-guide map](USER_GUIDE_MAP.md) provides task navigation. Split chapters only with stable compatibility anchors or redirects for existing inbound links.

### Required sequence for a subsystem extraction

1. Record current behavior, imports, exports, state ownership and test coverage.
2. Add or identify contract tests before moving implementation.
3. Extract one responsibility without changing public behavior.
4. Update source maps, package files, static asset allowlists and service-worker cache inputs where relevant.
5. Run focused tests, then `npm run check`, then the complete same-commit CI matrix.
6. Review the diff for dependency cycles, widened permissions, compatibility drift, missing tests and stale documentation.

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
- Description: Open-source, local-first agentic development workspace for coding, automation, agent orchestration, and verification.
- Current development package version: `1.0.0` (Release Candidate 1).
- Lifecycle: Release Candidate / Production Qualification.
- Latest published stable release: `v0.4.0` (historical; do not confuse it with the current source package).
- License: Apache-2.0.

Keep release, download, quality and benchmark badges tied to real published artifacts or current evidence. Search metadata and social previews do not guarantee indexing, traffic or ranking. Repository administration credentials belong only in GitHub Actions secrets; never commit or paste them into documentation.

For the logo, color tokens and interface rules, see [Brand](BRAND.md). For user-visible product claims, the README and [Project plan](PROJECT_PLAN.md) are authoritative.

 
## Publishing and public metadata operations

The static public landing page is in `site/`. The root `index.html` is the local browser workspace. The Pages workflow validates the application/site, deploys only `site/`, and can update the repository homepage, About description, and topic list. Pull-request runs validate only; repository administration changes require the configured secret.

To authorize publishing, create a fine-grained personal access token scoped only to `FAHTHIZ/oasis` with **Administration: Read and write** (repository About metadata) and **Pages: Read and write** (Pages settings/deployment). Store it in the repository Actions secrets as `OASIS_REPO_ADMIN_TOKEN`; never commit it or paste it into chat, an issue, or a log. The workflow skips privileged updates when the secret is absent and records the skip in its summary.

Run [Publish OASIS homepage and repository metadata](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml) on `main` after the site and metadata are ready. Verify the actual deployment URL and repository About fields after the run. A passing validation without a successful deployment is not proof that the public site is live.

Search metadata, Open Graph tags, `robots.txt`, and a sitemap help crawlers understand the site; they do not guarantee indexing, ranking, or traffic. Use Google Search Console to inspect indexing and request a crawl when appropriate; a request is not a guarantee of inclusion.

The canonical public identity is maintained in [Brand](BRAND.md). The README, project plan, release notes, package version, desktop release workflow, and public site must distinguish the unpublished `1.0.0` candidate from the historical stable `v0.4.0` release. Add release/download/benchmark badges only when the relevant release or result actually exists.
