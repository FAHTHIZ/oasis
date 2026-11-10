# Downloads and releases

OASIS ships as the `oasis` command, which runs the terminal agent and serves the web workspace (`oasis web`), and as an optional [desktop app](DESKTOP.md) built from the same runtime. Any modern browser on any device is also an interface; there is no separate mobile app.

Releases are published on [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases). Each release carries the npm tarball (`oasis-oss-<version>.tgz`), the desktop installers (Windows `.exe`, macOS `.dmg`, Linux `.AppImage` and `.deb`) and a `SHA256SUMS` file covering all of them.

## Install

| Platform | Command |
| --- | --- |
| macOS, Linux | `curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh \| sh` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.ps1 \| iex` |
| Homebrew | `brew tap fahthiz/oasis https://github.com/FAHTHIZ/oasis && brew install fahthiz/oasis/oasis-cli` |
| Release tarball | `npm install --global ./oasis-oss-<version>.tgz` |
| From source | `git clone https://github.com/FAHTHIZ/oasis.git && cd oasis && npm install && npm install --global .` |

All methods need Node.js 22.15 or newer and Git.

## Verify a download

On macOS or Linux:

```sh
shasum -a 256 -c SHA256SUMS
```

On Windows PowerShell, compare the output with the matching line in `SHA256SUMS`:

```powershell
Get-FileHash .\oasis-oss-<version>.tgz -Algorithm SHA256
```

Only install files attached to a GitHub Release. Temporary GitHub Actions artifacts are not releases.

## How releases are published

`.github/workflows/release.yml`:

1. Installs dependencies and runs the quick quality gate.
2. Packs the npm tarball and installs it into a clean prefix as a smoke test.
3. Builds the desktop installers on Windows, macOS and Linux runners, runs the desktop unit tests, and launches each packaged app to check that its workspace answers. This runs on every push to `main`, so a broken desktop build shows up before a release.
4. Waits for the same commit's `quality.yml` and `installer-checks.yml` runs to pass.
5. Publishes the versioned GitHub Release with every installer and `SHA256SUMS`.
6. For stable releases, refreshes `Formula/oasis-cli.rb` on `main`.

The package version and release tag must match, and `package.json` `oasisRelease.channel` must be `stable`.
