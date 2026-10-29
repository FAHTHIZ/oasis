<p align="center">
  <img src="assets/oasis-readme-banner.svg" alt="OASIS — Code. Automate. Flourish." width="100%" />
</p>

<p align="center"><strong>Inspect. Edit. Verify.</strong> An open-source coding agent for your own projects and your own choice of model.</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <img src="https://img.shields.io/badge/status-beta-9BFF55.svg?style=flat" alt="Beta software" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache License 2.0" /></a>
</p>

## Two ways to start

### Download the app — no terminal needed

1. Open the [OASIS releases page](https://github.com/FAHTHIZ/oasis/releases/latest).
2. Download the file for your computer:
   - **Windows:** `.exe` installer
   - **macOS:** `.dmg` disk image
   - **Linux:** `.AppImage` or `.deb`
3. Open it, choose a project folder, and follow the model setup.

The installers are currently unsigned. Your operating system may show a warning. Before continuing, confirm the download came from the official OASIS release page. Signing and automatic updates are not yet configured.

### Install from the terminal — macOS, Linux, or Android/Termux

Paste this **single line** into your terminal. It downloads the installer, checks its SHA-256 against the published value below, and runs it only if the checksum matches.

```sh
sh -c 'set -eu; f="${TMPDIR:-/tmp}/oasis-install.sh"; curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh -o "$f"; expected=0969eb1ed71b21158bfe0ba3fe7a13b1198299d84fcbb5f4873574de47c287e5; if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$f"); actual=${actual%% *}; elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$f"); actual=${actual%% *}; elif command -v openssl >/dev/null 2>&1; then actual=$(openssl dgst -sha256 "$f"); actual=${actual##*= }; else echo "No SHA-256 tool found; see docs/INSTALL.md"; rm -f "$f"; exit 1; fi; if [ "$actual" != "$expected" ]; then echo "Installer checksum mismatch. Do not run it."; rm -f "$f"; exit 1; fi; if sh "$f"; then code=0; else code=$?; fi; rm -f "$f"; exit "$code"'
```

The installer checks Node.js 22+, asks before installing OASIS or changing your shell startup file, uses immutable source revision `27efc103994c26cab2331bb7037167372ceaa787` (package version `0.3.0`) rather than moving `main`, then runs `oasis doctor` and opens first-run setup. It never requests administrator rights. If Node.js is missing, it offers Termux's `pkg install nodejs` or Homebrew on a Mac when available; otherwise it shows the official Node.js download page.

**Published installer SHA-256:** `0969eb1ed71b21158bfe0ba3fe7a13b1198299d84fcbb5f4873574de47c287e5`

For **Windows PowerShell**, paste this one line. It checks the downloaded script's hash before running it:

```powershell
$p=Join-Path $env:TEMP 'oasis-install.ps1'; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.ps1' -OutFile $p; $expected='920e1c647c905977afc308ee9c72f8a9cac2f173c279460fa0ca35505f97efd3'; $actual=(Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant(); if($actual -ne $expected){Remove-Item $p -Force; throw 'Installer checksum mismatch. Do not run it.'}; & $p; $code=$LASTEXITCODE; Remove-Item $p -Force; exit $code
```

**Published Windows installer SHA-256:** `920e1c647c905977afc308ee9c72f8a9cac2f173c279460fa0ca35505f97efd3`

If the check fails, stop and do not run the script. Read the [installation guide](docs/INSTALL.md) or the [Android/Termux guide](docs/TERMUX.md).

## What is OASIS?

OASIS is an open-source, local-first AI coding agent. It helps inspect a codebase, plan focused edits, make approved changes, run checks, and explain what changed. Bring a supported model/provider of your choice; OASIS does not include a model or paid subscription.

## Why OASIS

- **Model choice:** supported cloud providers, compatible endpoints, OmniRoute, and local Ollama setups.
- **Review before action:** approval prompts, file snapshots, and verification commands help you inspect changes rather than blindly trusting a completion message.
- **Extensible:** MCP tools, skills, hooks, plugins, and bounded subagents add capabilities.
- **Open source:** Apache-2.0 licence.

We do not publish token-savings claims: there is no current, representative measurement that supports a number.

## Limits to know

OASIS is in beta, with platform and release gaps remaining. Commands normally run with your user permissions. The optional OS sandbox is disabled by default and currently targets Linux and macOS; Windows isolation is not available. `node-pty` is optional, and its native terminal behavior is not guaranteed on Android/Termux. The desktop installers are unsigned, automatic desktop updates are not implemented, and the browser workspace does not sync projects/tasks/notes with the CLI. Approval prompts reduce risk; they are not a substitute for isolation. See [current status and limitations](docs/CURRENT_STATUS.md) and the [security audit](docs/SECURITY_RELIABILITY_AUDIT.md).

## A real demo is still needed

The banner above is branding artwork, not a screen recording. A genuine 10–20 second recording of OASIS finding a bug, applying a fix, and running a verification command has not been captured yet. We will add it only after recording the real application.

## How it was built

This paragraph is intentionally left for the project owner to write in their own words. It should state which parts Fahim wrote, what AI tools helped with, and how the result was reviewed. We should not guess or invent authorship details.

## Explore the project

- [5-minute quickstart](docs/QUICKSTART.md)
- [Installation guide](docs/INSTALL.md)
- [Android/Termux guide](docs/TERMUX.md)
- [Detailed user guide](docs/USER_GUIDE.md)
- [Current status](docs/CURRENT_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security and reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md)
- [Whole-codebase gap register](docs/WHOLE_CODEBASE_GAP_REGISTER.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

Use Node.js 22 or newer:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm run check
```

The quality workflow tests Node.js 22, 24, and 26; runs portable security regressions on Ubuntu, macOS, and Windows; exercises a clean environment and the Linux PTY path; and runs browser end-to-end smoke checks. The new installer workflow exercises the pinned CLI installer on fresh Windows, macOS, and Linux runners. These checks are useful evidence, not a full security audit or a claim of complete platform parity.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
