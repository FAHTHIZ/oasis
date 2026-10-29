# Bug-fix and duplicate sweep

**Audit date:** 2026-10-29  
**Target:** `FAHTHIZ/oasis`, default branch `main`

This is a focused regression-and-duplication pass, not a claim that the repository is defect-free. Each confirmed fix belongs in `main`, with the relevant automated check used as evidence.

## Fixes in this pass

### Align the channel-redaction regression assertion

The runtime sanitizer calls `redactApprovalSecrets` before its channel-specific credential patterns. Provider-key-shaped values are therefore intentionally replaced with `[redacted secret]`. `test/channels.test.mjs` still expected the previous generic `[REDACTED]` marker, causing the same assertion to fail in the desktop packaging and homepage-publishing validation jobs before they reached packaging/deployment. The assertion now expects the secret-specific marker; the secret remains redacted.

### Remove repeated app-integrity markers

`scripts/check-site.mjs` listed both `rel="manifest"` and the service-worker registration anchor twice in its `required` array. Since the check only tests whether each marker exists in the app HTML, repeating those array items added no coverage. One copy of each marker remains; the assertions are unchanged in meaning.

## Duplicate inventory and decisions

- **Root `index.html` vs. `site/index.html`: keep both.** The root file is the interactive OASIS workspace/PWA; the `site/` file is the separate public landing page used by GitHub Pages. They have different layouts, functionality, metadata and deployment roles, so deleting one would break a real surface rather than remove duplicate code.
- **`assets/oasis-icon.svg` vs. `site/assets/oasis-icon.svg`: retain for now.** The files are byte-identical, but each is referenced from a different independently served asset root. Removing one safely requires a deliberate build/deployment asset-sharing step and verification of both paths; a blind deletion would break an icon URL.
- **Evaluation `BASE_SNAPSHOT` files: retain.** The same baseline blob is deliberately reused by independent evaluation tasks. Their task instructions, reference patches and verifiers define different tests; the repeated baseline is fixture reuse, not duplicate product source.
- **Other exact content duplicates:** no additional byte-identical non-snapshot source or test files were detected in the inspected repository tree during this pass. Similar names alone were not treated as proof of duplication.

## Validation record

Before this fix, the main-branch test run reported **680 passing and 1 failing test out of 681**. The failure was the stale channel-redaction expectation in `test/channels.test.mjs`; both the desktop and homepage publishing workflows stopped during their test-validation step. Linux, macOS and Windows security/runtime regression jobs had passed on that revision.

The commit containing these changes triggers fresh GitHub Actions checks. The post-fix result must be read from those new runs; this document does not assume they pass just because the assertion was corrected.

### Remove duplicate desktop persistence assertion

While applying the desktop-save regression correction, `test/desktop-package.test.mjs` ended up asserting the same host callback twice. One copy now checks the distinct non-desktop `saveConfig` fallback instead. The suite therefore checks both intended persistence routes rather than spending an assertion on duplicate coverage.
