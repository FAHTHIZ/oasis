# OASIS branch audit

**Audit date:** 2026-10-29  
**Canonical destination:** `main`  
**Scope:** 28 non-main branch tips visible during the October 29, 2026 audit. Comparisons were made against `main`; old branch names alone are not proof that their contents remain useful.

**Comparison baseline:** branch tips were compared against `main` at `b52f36a19a8bc8512a76fe9dc9c99299f41dadec`. The completed Quality Checks and homepage/repository validation passed on this baseline; its desktop packaging matrix was still running. The workspace-lock and restart-persistence tests are newer work and require current-head checks.

## Decisions

| Branch | Decision | Evidence and next action |
| --- | --- | --- |
| `cloud-engine/maturity-foundation` | **Ported selectively; obsolete branch** | Durable task history, interrupted-run recovery, isolated browser worktrees, bounded diff review, secret-scan gating, and regression tests are now on `main`; the isolated-worktree feature passed Quality Checks run #705. PR #23 is closed. Do not merge the stale branch tip over newer runtime/search changes; delete this ref after verifying its unique diff is represented or intentionally rejected. |
| `fix/preserve-current-provider-on-setup-20261027` | **Retire after CI** | The behavior was ported directly to main in commits `6459bff`, `d02f327`, and `b85f0b1`: setup now infers the selected configured provider, fresh guided setup still defaults to OmniRoute, and regression tests cover known/custom endpoints. PR #22 is stale and conflicts with current main. Wait for current-main CI before deleting the branch and closing the duplicate PR. |
| `docs/alpha-confidence-milestone-2026-10-29` | **Retire** | PR #27 is closed and not merged. The useful status/milestone content is represented in the main docs; its old comparison-only document is intentionally not being reintroduced as product identity. |
| `security/bound-mcp-oauth-metadata` | **Retire after security regression checks** | The current `src/mcp-oauth.mjs` contains the bounded metadata timeout/response-size handling and pinned DNS lookup logic. PR #26 is closed and its security work has been superseded in main. |
| `security/public-fetch-ssrf-hardening` | **Retire after security regression checks** | Current main contains private/special-purpose address checks, DNS answer pinning, response-size bounds, and related regression coverage. PR #25 is closed; compare against the live main code before any future security refactor. |
| `feat/context-ordering-todo` | **Retire after quick source check** | PR #1 is closed. The current main already has `src/context.mjs`, `todo_write`, context compaction and ordered tool handling from later work. Confirm no unique fix remains before deleting. |
| `feat/workspace-extensions-integration-hub` | **Retire** | The extension/integration hub was merged through PRs #3 and #4. The current main contains `src/extensions.mjs` and the associated runtime/UI work; the later duplicate PR #5 is closed unmerged. |
| `fix/omniroute-setup-default-20261027` | **Retire** | This is an older sibling of `fix/omniroute-setup-default-latest`; PR #19 merged the selected default behavior and current main still defaults new users to OmniRoute. |
| `fix/guided-onboarding-entrypoints` | **Retire** | The branch is behind main with no unique file diff in the comparison against main. |
| `fix/web-job-capacity-guard-20261027` | **Retire** | The branch is behind main with no unique file diff in the comparison against main. |
| `fix/web-job-capacity-main-20261027` | **Retire** | The branch is behind main with no unique file diff in the comparison against main. |
| `feat/eval-harness` | **Retire** | The evaluation harness landed through PR #2; the branch is behind main with no unique file diff. |
| `chore/public-launch-metadata` | **Retire** | Public launch/site checks landed through merged PR #24. |
| `feat/first-run-guided-onboarding` | **Retire** | Merged through PR #7. |
| `feat/mid-turn-context-compaction-20261027` | **Retire** | Merged through PR #17. |
| `feat/omniroute-chat-bootstrap` | **Retire** | Merged through PR #6. |
| `feat/openhands-agent-server-bridge` | **Retire** | Merged through PR #11. |
| `feat/ordered-tools-context-checklists-20261027` | **Retire** | Merged through PR #14. |
| `feat/parallel-readonly-specialists-20261027` | **Retire** | Merged through PR #21. |
| `feat/provider-transient-retries` | **Retire** | Merged through PR #10. |
| `fix/browser-session-start-lock-20261027` | **Retire** | Merged through PR #16. |
| `fix/omniroute-setup-default-latest` | **Retire** | Merged through PR #19. |
| `fix/verification-command-detection` | **Retire** | Merged through PR #9. |
| `fix/verification-gate-completeness` | **Retire** | Merged through PR #8. |
| `fix/web-job-capacity` | **Retire** | Merged through PR #15. |
| `test/browser-chat-tool-lifecycle` | **Retire** | Merged through PR #12. |
| `test/browser-e2e-smoke-20261027` | **Retire** | Merged through PR #18. |
| `test/browser-e2e-tool-cycle-20261027` | **Retire** | Merged through PR #20. |

## Cleanup rule

Keep `main` as the sole long-lived integration branch. Remove a branch only after its useful diff is either present on main or explicitly rejected. Merged feature branches do not need to remain as permanent branches: their commits remain reachable from the default branch after deletion. The cloud-engine branch is the only identified branch with a substantial, not-yet-integrated capability set; the provider-setup change has been ported and is awaiting a green main-branch verification run.

## Current comparison results and cleanup state

The live comparison against the audited `main` head found these branches fully behind `main` with no unique commits to port: `chore/public-launch-metadata`, `feat/eval-harness`, `fix/guided-onboarding-entrypoints`, `fix/web-job-capacity`, `fix/web-job-capacity-guard-20261027`, and `fix/web-job-capacity-main-20261027`. These are cleanup candidates once current-main CI is green.

Other branch tips have unique commits or diverged file trees. Several contain work already merged through squash/rebase or superseded by later code; use the per-branch decisions above rather than treating `ahead_by` as proof that a feature is missing. The cloud-engine branch's useful task-history, recovery, isolated-worktree, and diff-review capabilities were ported selectively to `main` and tested in run #705. Its stale full tree must not be merged over newer runtime/search changes.

The available GitHub actions do not expose remote branch deletion, so no remote branch refs have been deleted from this session. PRs #22 and #23 are closed; the useful cloud-engine work is now represented on `main`. The remaining merged/superseded branch refs are cleanup candidates, but branch deletion itself must be performed through GitHub's branch-management UI or an authorized tool that supports deleting refs. The latest fully completed quality evidence is [run #726](https://github.com/FAHTHIZ/oasis/actions/runs/40818083171) on commit `5a53756`: 594 tests, 22 fixtures, Node 22/24/26, PTY and browser E2E passed. Homepage/repository validation [run #468](https://github.com/FAHTHIZ/oasis/actions/runs/40818083169) passed on the same code revision.


## Latest full branch inventory (2026-10-29)

**Comparison baseline:** `main` at `d4cd33911efe95d4150ae98bcb5716d5e255089f`. This table records Git ancestry counts, not a guarantee of content equivalence; squash/rebase merges can leave ahead counts even when a feature was ported.

| Branch | Ahead | Behind | Assessment |
| --- | ---: | ---: | --- |
| `app/alpha-readiness-gaps` | 21 | 136 | Diverged; inspect unique app changes before retirement |
| `app/empty-chat` | 33 | 329 | Diverged; inspect unique app changes before retirement |
| `app/first-run` | 24 | 329 | Diverged; inspect unique app changes before retirement |
| `app/status-activity` | 34 | 329 | Diverged; inspect unique app changes before retirement |
| `app/workspace-layout` | 29 | 329 | Diverged; inspect unique app changes before retirement |
| `chore/current-head-verification-status` | 2 | 53 | Stale closed-PR branch; check content overlap, then retire |
| `chore/public-launch-metadata` | 0 | 678 | Behind-only; safe retirement candidate |
| `cli/getting-started` | 24 | 327 | Diverged; inspect unique CLI changes before retirement |
| `cloud-engine/maturity-foundation` | 51 | 726 | Diverged; preserve only verified missing improvements |
| `docs/alpha-confidence-milestone-2026-10-29` | 13 | 575 | Diverged docs branch; audit relevant documentation diff |
| `feat/context-ordering-todo` | 7 | 923 | Diverged; verify source-equivalent port before retirement |
| `feat/eval-harness` | 0 | 793 | Behind-only; safe retirement candidate |
| `feat/first-run-guided-onboarding` | 13 | 790 | Merged/ported feature; compare tree before retirement |
| `feat/mid-turn-context-compaction-20261027` | 5 | 779 | Merged/ported feature; compare tree before retirement |
| `feat/omniroute-chat-bootstrap` | 16 | 791 | Merged/ported feature; compare tree before retirement |
| `feat/openhands-agent-server-bridge` | 8 | 786 | Closed duplicate PR lineage; verify current adapter before retirement |
| `feat/ordered-tools-context-checklists-20261027` | 10 | 784 | Merged/ported feature; compare tree before retirement |
| `feat/parallel-readonly-specialists-20261027` | 4 | 776 | Merged feature; compare tree before retirement |
| `feat/provider-transient-retries` | 2 | 787 | Merged feature; compare tree before retirement |
| `feat/workspace-extensions-integration-hub` | 77 | 793 | Merged/ported feature; do not merge stale branch wholesale |
| `fix/browser-session-start-lock-20261027` | 4 | 780 | Merged feature; compare tree before retirement |
| `fix/chained-command-permissions` | 3 | 401 | Closed unmerged fix; verify permission behavior before retirement |
| `fix/guided-onboarding-entrypoints` | 0 | 789 | Behind-only; safe retirement candidate |
| `fix/omniroute-setup-default-20261027` | 3 | 779 | Older sibling of newer OmniRoute branch |
| `fix/omniroute-setup-default-latest` | 3 | 778 | Merged feature; compare tree before retirement |
| `fix/preserve-current-provider-on-setup-20261027` | 3 | 774 | Ported fix; retain until current-main regression suite passes |
| `fix/safety-part-1-completion` | 7 | 325 | Closed unmerged; verify safe runtime changes before retirement |
| `fix/verification-command-detection` | 2 | 788 | Merged feature; compare tree before retirement |
| `fix/verification-gate-completeness` | 2 | 789 | Merged feature; compare tree before retirement |
| `fix/web-job-capacity` | 0 | 782 | Behind-only; safe retirement candidate |
| `fix/web-job-capacity-guard-20261027` | 0 | 783 | Behind-only; duplicate tip with next entry |
| `fix/web-job-capacity-main-20261027` | 0 | 783 | Behind-only; duplicate tip with previous entry |
| `security/bound-mcp-oauth-metadata` | 2 | 677 | Closed security branch; verify equivalent hardening before retirement |
| `security/public-fetch-ssrf-hardening` | 8 | 677 | Closed security branch; verify equivalent hardening before retirement |
| `test/browser-chat-tool-lifecycle` | 1 | 785 | Merged feature; compare tree before retirement |
| `test/browser-e2e-smoke-20261027` | 9 | 778 | Merged feature; compare tree before retirement |
| `test/browser-e2e-tool-cycle-20261027` | 6 | 776 | Merged feature; compare tree before retirement |

The six behind-only candidates are preserved in the list until an authorized deletion operation is available. Branches with nonzero ahead counts must have their file-tree differences inspected before deletion; do not merge stale branch tips over newer `main`.
