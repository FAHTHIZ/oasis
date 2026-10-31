# Contributing to OASIS

Thanks for helping with OASIS! The project is currently in beta, and small, careful improvements are welcome. See [the project plan and release gates](docs/PROJECT_PLAN.md) before assuming a capability is complete.

## Before you begin

1. Describe the problem your change fixes.
2. Read the related code before editing it.
3. Work on a feature or fix branch, not on `main`.
4. Keep changes small enough to test and review.
5. Never commit API keys, runtime tokens, browser exports, private workspace data or other secrets.

## Run the checks

Use Node.js 22 or newer. From the repository folder, run:

```bash
npm install
npm run check
```

For the normal test suite, run:

```bash
node --test
```

If you change the browser app, try it in a desktop-sized window and at 390px width. Check both themes, keyboard-only use, `NO_COLOR` in terminal output, and `OASIS_NO_ANIMATION=1` where relevant. If you cannot run a check, say so instead of claiming it passed.

## Pull requests

Explain what changed, give the exact commands you ran and their results, update the documentation, and list anything you did not verify. Do not describe a planned integration as shipped.

New packages should be rare. Pin an exact version, confirm a suitable licence, run `npm audit`, and document the reason in the dependency inventory below.

## Safety

OASIS runs code with your user permissions. Approval prompts help you review actions, but they are not the same as an operating-system sandbox. Do not test untrusted code in a personal or sensitive folder.


## Direct dependencies and change policy

Current direct application/runtime packages are pinned exactly in `package.json`:

| Package | Version | Purpose |
|---|---:|---|
| `@xterm/xterm` | `6.0.0` | Browser terminal display |
| `@xterm/addon-fit` | `0.11.0` | Terminal panel sizing |
| `quickjs-emscripten` | `0.32.0` | Isolated workflow JavaScript runtime |
| `node-pty` | `1.1.0` (optional) | Native pseudo-terminal support |
| `electron` | `45.1.0` (development/package build) | Desktop app runtime |
| `electron-builder` | `26.4.0` (development/package build) | Desktop installer packaging |

Browser CI installs Playwright `1.64.1` and `@axe-core/playwright` `4.14.0` dynamically; they are not production runtime dependencies.

Prefer built-in Node.js/browser APIs when sufficient. For each new direct dependency, record purpose, exact version and licence, inspect upstream security/maintenance, run `npm audit`, `npm run check` and relevant packaging tests. The listed licences are upstream package expectations, not a complete transitive third-party notice inventory.
