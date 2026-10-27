# Oasis OSS architecture

## Current implementation

Oasis is a static, dependency-free web application. The index.html file contains the interface, styles, and client-side behavior. The app can be opened directly or served by any static web server.

### State

- projects: project identity, title, description, symbol, status, and creation date.
- tasks: title, project association, priority, completion state, and creation date.
- notes: a plain-text working note.
- lastSaved: the last in-memory save timestamp.

The whole state is serialized under the oasis.oss.workspace.v1 key in browser local storage. Theme preference uses oasis.oss.theme. Data is local to the browser profile; there is no sync or cloud recovery.

### Backup/import

Export serializes the current workspace to a downloadable JSON document. Import checks the broad data shape, filters malformed project/task entries, and asks before replacing existing local state. Backups are user data and should not be committed to the repository.

### Quality checks

scripts/check-site.mjs verifies key app anchors and parses the inline JavaScript. GitHub Actions runs it for pushes and pull requests and before Pages deployment. It is a smoke check, not a browser integration suite.

## Non-goals of this first implementation

The app does not currently connect to GitHub, remote APIs, AI providers, a hosted database, or other devices. There are no user accounts, encryption, multi-user collaboration, native app packaging, or cloud sync. The UI and documentation intentionally do not imply these capabilities.

## Evolution principles

1. Keep the workspace useful without an account or network connection.
2. Preserve user control through visible backup and import flows.
3. Add integrations as explicit optional adapters, not hidden assumptions.
4. Do not introduce credential storage before a clear threat model and secure design.
5. Keep shipped behavior, experimental behavior, and roadmap ideas clearly distinct.
