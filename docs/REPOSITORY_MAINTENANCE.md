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
| `assets/` | Shared app artwork, fonts, styles, and demo media. Keep public-site deployment copies under `site/assets/` when the deployed site needs a self-contained asset tree. |
| `bench/` | Focused performance and subsystem benchmark scripts; benchmark outputs are evidence, not product claims by themselves. |
| `scripts/` | Installers, environment checks, packaging helpers, local maintenance scripts, and developer utilities. |
| `index.html`, `manifest.webmanifest`, `sw.js` | Root browser-workspace shell, PWA metadata, and service-worker entry. |
| `package.json`, lockfile | Package identity, Node engine floor, dependencies, export surface, scripts, and desktop build configuration. Keep these in sync with the release process. |
| Root `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` | Public entry point, user-facing history, legal terms, vulnerability reporting, and contribution contract. Keep the root concise; detailed guidance belongs under `docs/`. |

## Intentional exact-content copies

The repository-wide blob scan found only a small set of byte-identical groups. They are deliberate, not cleanup targets:

- `assets/oasis-icon.svg`, `assets/oasis-mark.svg` and `assets/oasis-social-preview.svg` have matching copies under `site/assets/`. The static site is deployed as a self-contained directory, so its asset paths must exist at that root.
- A few shared skill files match their copies under `evals/snapshots/oasis-main/skills/`. Snapshot copies are frozen baselines; source-skill improvements must not rewrite historical benchmark inputs.
- The 33 `evals/tasks/*/repo/BASE_SNAPSHOT` pointer files intentionally share one tiny blob. Each pointer is task metadata referring to a reusable named snapshot, not duplicate source code.
- Root `index.html` and `site/index.html` are not duplicates: one is the app workspace, the other the public landing page.

Before removing any same-content file, check its deployment root, task snapshot, importer, package manifest and tests. Do not consolidate copies merely because their bytes match.

## Branch state and cleanup receipt

At the inspected `main` snapshot `ebb5fa1321bb8eae9d57b5f4b91e3ccb75b8a615`, the GitHub branches endpoint returned exactly one branch: `main`. This confirms that the former development refs listed in older audit notes are no longer present. Do not use those historical names as active branches or assume they remain recoverable.

The guarded cleanup workflow completed successfully in the latest inspected pass: [run 41265370788](https://github.com/FAHTHIZ/oasis/actions/runs/41265370788). Earlier cleanup receipts are retained as history:

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

 
## Publishing and public metadata operations

The static public landing page is in `site/`. The root `index.html` is the local browser workspace. The Pages workflow validates the application/site, deploys only `site/`, and can update the repository homepage, About description, and topic list. Pull-request runs validate only; repository administration changes require the configured secret.

To authorize publishing, create a fine-grained personal access token scoped only to `FAHTHIZ/oasis` with **Administration: Read and write** (repository About metadata) and **Pages: Read and write** (Pages settings/deployment). Store it in the repository Actions secrets as `OASIS_REPO_ADMIN_TOKEN`; never commit it or paste it into chat, an issue, or a log. The workflow skips privileged updates when the secret is absent and records the skip in its summary.

Run [Publish OASIS homepage and repository metadata](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml) on `main` after the site and metadata are ready. Verify the actual deployment URL and repository About fields after the run. A passing validation without a successful deployment is not proof that the public site is live.

Search metadata, Open Graph tags, `robots.txt`, and a sitemap help crawlers understand the site; they do not guarantee indexing, ranking, or traffic. Use Google Search Console to inspect indexing and request a crawl when appropriate; a request is not a guarantee of inclusion.

The canonical public identity is maintained in [Brand](BRAND.md). The README, project plan, release notes, and public site must distinguish the latest published release from newer unreleased changes on `main`. Add release/download/benchmark badges only when the relevant release or result actually exists.
