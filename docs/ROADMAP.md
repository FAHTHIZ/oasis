# Oasis OSS roadmap

This roadmap separates working behavior from ideas that need design and implementation. Items are not shipped simply because they appear here.

## Shipped in the initial foundation

- Responsive static dashboard
- Project creation, filtering, progress, completion/reopen, and removal
- Task creation, completion, priorities, search, and deletion
- Local working notes and word count
- Browser-local persistence
- JSON backup/export and import/restore
- Light/dark theme toggle
- Static integrity check and GitHub Actions workflows
- Privacy, architecture, contribution, and license documentation

## Next milestones

### 1. Browser-quality pass
- Add automated browser tests for navigation, project/task flows, note saving, and backup/import.
- Test across mobile Chrome/Safari and desktop Chromium/Firefox.
- Improve recovery messaging for browser storage quotas and malformed backups.
- Review keyboard navigation, screen-reader semantics, and color contrast.

### 2. Product definition
- Confirm Oasis's long-term purpose and target audience before building deeper subsystems.
- Define a stable workspace schema and a migration strategy.
- Collect feedback on the smallest useful end-to-end workflow.

### 3. Optional integrations
- Evaluate GitHub repository linking as an opt-in read-only integration first.
- Define explicit consent, token handling, and permissions before any write-capable integration.
- Consider sync only after a privacy model, conflict strategy, and export path are documented.

### 4. Release readiness
- Add real browser end-to-end tests and accessibility checks.
- Verify Pages deployment and publish a first release only after CI passes.
- Add versioning and migration tests for future schema changes.

## Deliberately not promised

Cloud synchronization, user accounts, an AI assistant, GitHub write access, mobile binaries, and hosted collaboration are not part of the current implementation. They require product decisions, architecture, security review, and working tests before being represented as available.
