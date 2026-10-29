# Repository hygiene and file ownership

This document records the canonical locations for maintained files and the reasons some byte-identical files are intentional.

## Canonical source locations

- Runtime modules live in `src/`; the Node test suite lives in `test/`.
- Product and contributor documentation lives in `docs/`; `STATUS.md` is the current evidence inventory and `CHANGELOG.md` records user-visible increments.
- Shared first-party skills live in `skills/<name>/SKILL.md`.
- Bundled plugin examples/packages live under `plugins/`; workspace-installed plugin data belongs under the ignored `.oasis/` directory, not in the checked-in source tree.
- The lowercase `.github/pull_request_template.md` is the single canonical pull-request template. File paths differing only by case are prohibited because checkouts on case-insensitive filesystems can collide.

## Deliberate copies — do not delete as ordinary duplicates

- `assets/oasis-icon.svg` and `site/assets/oasis-icon.svg` are source/deployment copies. The static site must remain self-contained at its deployment root.
- `skills/environment-setup/SKILL.md`, `skills/ship-feature/SKILL.md`, and `skills/testing/SKILL.md` may byte-match the corresponding files under `evals/snapshots/oasis-main/skills/`. The snapshot copies are part of a frozen evaluation fixture; changing the source skill must not silently rewrite a historical baseline.
- `evals/snapshots/oasis-main/src/installer.mjs` is a frozen benchmark snapshot of the canonical runtime file, not a second runtime entry point.
- The repeated `evals/tasks/*/repo/BASE_SNAPSHOT` marker files are task fixture metadata. Their identical small contents are intentional.

Before removing any same-content file, inspect its references and whether it is a deployment artifact, compatibility entry point, or frozen test baseline. Prefer generating deployment copies from canonical sources where the publishing pipeline already supports that, but do not collapse a frozen baseline into a live source file.

## Automated guardrails

`test/repository-hygiene.test.mjs` scans tracked-workspace paths (excluding generated output and Git internals) and fails on path collisions that differ only by case. The standard `npm test` and `npm run check` flows include this regression test.

## Branch retirement

Keep `main` as the integration branch. Retire a branch only after comparing its tip to the current `main`, checking open and closed pull requests, and confirming that useful changes are already present or explicitly rejected. A branch behind `main` with zero commits ahead is a safe retirement candidate; a nonzero ahead count is not by itself evidence that the work is missing or safe to delete. Keep the branch audit evidence current in `docs/BRANCH_AUDIT.md`.
