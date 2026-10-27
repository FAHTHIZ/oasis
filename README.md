# Oasis OSS

**A calm, local-first workspace for projects, tasks, and working notes.**

Oasis gives your work a home without asking you to create an account, configure a server, or connect a model. The first version is a dependency-free browser app designed to run as a static site.

## What works today

- **Overview dashboard** with project progress, open/completed tasks, and quick add.
- **Project management** with create, search, filter, progress, completion/reopen, and removal.
- **Task management** with completion toggles, priorities, project association, search, and deletion.
- **Working notes** with automatic local saving and a word count.
- **Workspace backup and restore** using JSON export/import.
- **Light and dark themes**, responsive phone navigation, keyboard focus styles, and reduced-motion support.
- **Installable PWA shell** with an app icon and service-worker caching for the core interface.
- **Static hosting** support and GitHub Actions quality checks.

## Run it

No build step or package install is needed. Open **index.html** in a modern browser, or serve the repository with any static HTTP server.

For a local server with Python:

~~~bash
python -m http.server 8000
~~~

Then open http://localhost:8000.

## Data, privacy, and limits

- Projects, tasks, theme preference, and notes are stored in this browser's local storage.
- The app does **not** connect to GitHub, a cloud database, or an AI provider.
- Data does not automatically sync across browsers or devices.
- The service worker caches the app shell, not your data or a cloud service. The first visit requires a working network connection when hosted.
- Browser storage is not encrypted. Do not store passwords, API keys, private keys, or sensitive personal information.
- Use **Export backup** before clearing site data or moving to another device.
- Import replaces the current workspace only after a confirmation prompt.
- The starter data is illustrative and can be changed or removed.

These limitations are intentional and visible. The interface does not pretend that a cloud service or account system exists.

## Deploy to GitHub Pages

A Pages deployment workflow is included at .github/workflows/pages.yml.

1. In the repository, open **Settings → Pages**.
2. Choose **GitHub Actions** as the build and deployment source.
3. Push to the main branch (or manually run the Pages workflow from the Actions tab).
4. Open the URL reported by the successful deployment workflow.

The repository setting in Step 2 requires an owner/admin action and is not changed by a code commit. A successful CI test does not, by itself, mean the public site is deployed. Once hosted over HTTPS, a compatible browser can offer installation; offline launch depends on the service worker having installed successfully.

## Repository map

- **index.html** — responsive app and client-side interactions.
- **scripts/check-site.mjs** — dependency-free integrity and JavaScript syntax checks.
- **.github/workflows/quality.yml** — checks pushes and pull requests.
- **.github/workflows/pages.yml** — validates and deploys the static site.
- **docs/ARCHITECTURE.md** — current architecture and data boundaries.
- **docs/ROADMAP.md** — staged next steps, separate from shipped functionality.

## Development checks

Requires Node.js 20 or newer:

~~~bash
node scripts/check-site.mjs
~~~

The check validates required UI anchors and parses the inline JavaScript for syntax errors. It is a useful smoke check, not a substitute for accessibility review, real-device testing, or end-to-end browser tests.

## Contributing

See CONTRIBUTING.md. Security reports: see SECURITY.md.

## License

MIT. See LICENSE.
