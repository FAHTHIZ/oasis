# Dependencies

OASIS intentionally keeps its dependency list small. Versions below are the exact pins in `package.json`; update a pin only after checking the current upstream release, compatibility and licence, then running `npm audit` and the full test suite.

| Package | Pinned version | Purpose | Licence |
| --- | --- | --- | --- |
| `@xterm/xterm` | `6.0.0` | Terminal display in the browser workspace | MIT |
| `@xterm/addon-fit` | `0.11.0` | Fits the terminal to its panel | MIT |
| `quickjs-emscripten` | `0.32.0` | Runs constrained JavaScript workflow code | MIT |
| `node-pty` | `1.1.0` (optional) | Native pseudo-terminal process support | MIT |
| `electron` | `45.1.0` (development/package build) | Desktop application runtime | MIT |
| `electron-builder` | `26.4.0` (development/package build) | Creates Windows, macOS and Linux installers | MIT |

The licence labels above are the expected upstream package licences; verify the actual published package metadata and bundled notices when changing versions. This short table is not a complete third-party notice inventory for every transitive dependency.

## Rules for changes

- Prefer built-in Node.js and browser APIs when they are enough.
- Do not add a package just to save a few lines of straightforward, auditable code.
- Pin exact versions; do not use `^` or `~` ranges.
- Avoid runtime CDN scripts. Browser assets should be bundled locally.
- Do not add GPL-licensed code to the application.
- For every new direct dependency, record the reason, exact version and licence here.
- Before merging a dependency change, run `npm audit`, `npm run check`, and the desktop/browser packaging checks that cover it. Record audit findings accurately; an audit can report issues in transitive packages too.

## CI-only browser audit tooling

These exact versions are installed ephemerally by the browser E2E workflow. They are test tools only and are not included in the OASIS application package or runtime dependency tree.

| Package | Pinned version | Purpose | Licence |
| --- | --- | --- | --- |
| \`playwright\` | \`1.64.1\` | Headless Chromium browser tests and screenshots | Apache-2.0 |
| \`@axe-core/playwright\` | \`4.14.0\` | WCAG color-contrast audit of the Agent view at desktop and phone widths | MPL-2.0 |
