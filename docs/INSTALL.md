# Installing and starting OASIS

OASIS `1.0.0` is the stable-channel version on `main`.

> **Publication status (checked November 5, 2026):** [`v1.1.0`](https://github.com/FAHTHIZ/oasis/releases/tag/v1.1.0) is published as the latest GitHub Release. The stable installer, `oasis update` and the desktop download links resolve to it.

Use a project folder you trust, review permission prompts, and keep important work in version control before running an agent on it.

## Desktop app — no terminal required

> **Downloads:** desktop installers are on the [latest release](https://github.com/FAHTHIZ/oasis/releases/latest) page. They are **not code-signed**, so Windows SmartScreen and macOS Gatekeeper will warn on first launch; verify the file against `SHA256SUMS` first (below). To build them yourself, run `npm install && npm run desktop:dist` (output in `release/`). Installation and packaging are tested on clean CI runners for Windows, macOS and Linux, not by hand on physical machines.

The Electron app is configured for Windows, macOS and Linux. Choose the matching asset from the [latest release](https://github.com/FAHTHIZ/oasis/releases/latest): Windows x64 `.exe`, macOS Apple Silicon / arm64 `.dmg`, or Linux x86_64 `.AppImage` / `.deb`. Starting with v1.1.0, releases also include macOS Intel (x64) and Linux ARM64 builds, plus Windows ARM64 whenever that optional CI build succeeds (v1.1.0 shipped without it; Windows on ARM runs the x64 installer through emulation). The [download page](https://fahthiz.github.io/oasis/) detects your system and links to the matching file. The packaged app includes its own runtime: you do not need to install Node.js or Git separately.

| Operating system | Download | First launch |
|---|---|---|
| Windows 10/11, x64 | `.exe` installer | Run the installer. It installs for the current user and adds Start Menu/Desktop shortcuts. |
| macOS, Apple Silicon (arm64) | `.dmg` disk image | Open the image and drag OASIS into Applications. |
| Linux, x86_64 | `.AppImage` or `.deb` | Run the AppImage or open the package with your software installer. |
| macOS Intel, Linux ARM64 (from v1.1.0) | `-x64.dmg`, `-arm64.AppImage` / `-arm64.deb` | Same as above. |
| Windows on ARM | `-arm64.exe` when published, otherwise the x64 `.exe` | The x64 installer runs through Windows' built-in emulation. The native ARM64 build is optional, so a release can be missing it. |
| iPhone, iPad, Android | No store app | Use the browser workspace from your phone, or Termux on Android: see [MOBILE.md](MOBILE.md). |

Desktop builds are unsigned. Verify downloads against the release `SHA256SUMS` file, downloaded from the same release page. Checksums detect corruption and tampering in transit; they are not a publisher signature.

### Updates

From v1.1.0, the desktop app checks GitHub for a new stable release 15 seconds after launch and every six hours after that. When one is out, you get a system notification and a banner in the workspace. **Help → Check for updates…** checks right away. Choosing **Install and restart** downloads the installer for your system from the GitHub release. It checks the file against that release's `SHA256SUMS` and deletes it if it doesn't match. Then:

- **Windows:** reinstalls silently and reopens.
- **Linux AppImage:** replaces the AppImage in place and restarts.
- **macOS `.dmg` and Linux `.deb`:** opens the file so you can finish with the system installer. Unsigned macOS apps cannot replace themselves.

You can also choose **Later** or **Skip this version**. To check right away, use **Help → Check for updates…** in the desktop app or **Settings → Devices → Updates** in the browser workspace. Projects, settings and keys are never touched. Set `OASIS_NO_UPDATE_CHECK=1` to turn checks off, or `OASIS_UPDATE_CHANNEL=beta` to include pre-releases. The CLI and `oasis web` show the same notice and point to `oasis update`. v1.0.0 has no update checker, so install v1.1.0 once by hand; later updates are offered automatically.

```sh
# macOS / Linux, in the folder with both files
sha256sum -c SHA256SUMS --ignore-missing   # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
```

```powershell
# Windows PowerShell: compare with the matching line in SHA256SUMS
(Get-FileHash .\OASIS-1.0.0-x64.exe -Algorithm SHA256).Hash.ToLower()
```

On first launch:
1. Choose a project folder, not your entire home directory.
2. Open **Model provider** and choose an API key, an already-running OmniRoute-compatible gateway, or a local Ollama model.
3. For API keys, select the provider and enter the key into the masked field. The Electron app uses OS-backed secure storage and refuses to save a new key if encryption is unavailable.
4. For Ollama, install and start Ollama, download a model, and then select the model from OASIS.
5. Test the provider before starting a coding task. The provider probe checks whether the model can return an inert tool call; it never executes that tool.

The CLI guided setup can install OmniRoute through npm, request approval to start its local gateway, and verify tool calling before saving the provider. The desktop setup does not yet provide that entire gateway-install flow inside its UI; use an API key or an already-running local provider. OASIS does not include a model or paid subscription.

## Command-line installation

The supported installer resolves the latest stable versioned Git tag to an immutable commit SHA. It does not install the moving `main` branch. `v1.0.0` is currently the install and update target. Install from source only when you deliberately want unreleased changes from `main`. Node.js 22 or newer is required; on Termux, the installer can offer to install Node.js using `pkg`.

Maintainer and CI smoke tests may set `OASIS_INSTALL_COMMIT` to a full 40-character Git SHA to install one exact source revision. This override is intended for validating the installer against the commit under test; normal installations should leave it unset so the installer resolves the latest stable release.

### macOS, Linux and Android/Termux

Quick install, using the script from the immutable `v1.0.0` tag:

```sh
curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/v1.0.0/scripts/install.sh | sh
```

To verify the installer's SHA-256 before it runs, use the checksum-verified bootstrap instead:

```sh
sh -c 'set -eu; f=$(mktemp "${TMPDIR:-/tmp}/oasis-install.XXXXXX"); cleanup() { rm -f "$f"; }; trap cleanup EXIT; trap "exit 1" HUP INT TERM; url=https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh; if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$f"; elif command -v wget >/dev/null 2>&1; then wget -qO "$f" "$url"; else echo "Install curl or wget first, then retry." >&2; exit 1; fi; expected=f8993e4c4ab964f2026efa23b2771569e5fd4515868b19c3dcca2f80c92611c2; if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$f"); actual=${actual%% *}; elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$f"); actual=${actual%% *}; elif command -v openssl >/dev/null 2>&1; then actual=$(openssl dgst -sha256 "$f"); actual=${actual##*= }; else echo "No SHA-256 tool found; see docs/INSTALL.md"; rm -f "$f"; exit 1; fi; if [ "$actual" != "$expected" ]; then echo "Installer checksum mismatch. Do not run it."; rm -f "$f"; exit 1; fi; if sh "$f"; then code=0; else code=$?; fi; rm -f "$f"; exit "$code"'
```

**Installer SHA-256:** `f8993e4c4ab964f2026efa23b2771569e5fd4515868b19c3dcca2f80c92611c2`

### Windows PowerShell

Download and verify both the installer and resolver helper before running:

```powershell
$d=Join-Path $env:TEMP ('oasis-install-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force -Path $d | Out-Null; $p=Join-Path $d 'install.ps1'; $h=Join-Path $d 'release-resolution.ps1'; try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.ps1' -OutFile $p; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/release-resolution.ps1' -OutFile $h; $expected='28da1a8ae720c0579724718b0696ae011cec68de3e90169d379e40a9f3dddfa9'; $actual=(Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant(); $helperExpected='a88ec877205ab792310c04179f702ceff13bfb3adb5d2d58345bb70fc459a19d'; $helperActual=(Get-FileHash $h -Algorithm SHA256).Hash.ToLowerInvariant(); if($actual -ne $expected -or $helperActual -ne $helperExpected){throw 'Installer checksum mismatch. Do not run either file.'}; & $p; $code=$LASTEXITCODE } finally { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }; if ($null -ne $code) { exit $code }
```

**Windows installer SHA-256:** `28da1a8ae720c0579724718b0696ae011cec68de3e90169d379e40a9f3dddfa9`  
**Windows resolver helper SHA-256:** `a88ec877205ab792310c04179f702ceff13bfb3adb5d2d58345bb70fc459a19d`

If any checksum differs, do not run the downloaded file. The installer sets up the CLI, runs `oasis doctor` and opens guided provider setup. npm publishing is not enabled; the source-archive install path is used.

After installation, `oasis update` checks the latest stable release, resolves it to an immutable commit and asks before replacing the CLI (`--check` only reports; `--help` lists the options). If the GitHub API is rate-limited (60 unauthenticated requests an hour per IP address), the update check reads the same release from github.com pages; setting `GH_TOKEN` or `GITHUB_TOKEN` raises the API limit. `oasis uninstall` asks before removing the CLI and retains projects, settings, saved sessions, memory and API keys.


### Run from source

To run the latest `main` instead of the pinned stable release:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install -g .
oasis --version
```

This installs whatever is on `main`, which can include changes not yet in a tagged release.

## Tab completion

Let your shell finish `oasis` commands and options when you press Tab. Run the line for your shell once, or add it to the shell's start-up file:

| Shell | Command | Start-up file |
|---|---|---|
| bash | `eval "$(oasis completion bash)"` | `~/.bashrc` |
| zsh | `eval "$(oasis completion zsh)"` | `~/.zshrc` |
| fish | `oasis completion fish > ~/.config/fish/completions/oasis.fish` | (saved file) |
| PowerShell | `oasis completion powershell \| Out-String \| Invoke-Expression` | `$PROFILE` |

## Automatic setup for your hardware

`oasis setup --auto` looks at this computer, then picks the best way to run a model here:

- **What it checks:** the OS, CPU cores, memory and GPU (NVIDIA through `nvidia-smi`; AMD and Intel cards through Linux sysfs or the Windows registry, which reports real VRAM above 4 GB; Apple Silicon unified memory; integrated graphics under 2 GB are ignored in favour of system memory), plus any model server already running on its usual local port (Ollama, LM Studio, llama.cpp, Jan, vLLM, OmniRoute).
- **What it chooses:** a running model that fits, a local gateway, an Ollama model sized to your memory (with the exact `ollama pull` command), or a hosted model if the device is too small.
- **What it saves:** the route only after a real test request succeeds. Add `--dry-run` to see the recommendation without saving.

`oasis doctor` prints the same hardware summary. The desktop app and the browser workspace show it as **Recommended for this computer** on the first-run screen.

## First useful session

Start in a project you understand. Ask OASIS to explain the repository before asking it to edit:

> Read this repository. Explain its main parts and how they connect. Do not change any files yet.

Then try a small, bounded task:

> Find one clear bug. Explain the evidence and a minimal fix, change only the necessary files, and run the relevant tests. Tell me clearly if you cannot verify the result.

Review every proposed command and file change before approving it.

## Troubleshooting

- **No model connected:** open Model provider or run `oasis setup`, then test the connection.
- **Ollama not found:** install/start Ollama, pull a model, and retry model discovery.
- **Provider test fails:** check provider, exact model ID, endpoint URL, account access and key. Failed tests do not replace the current provider configuration.
- **Command approval appears:** read the operation and target. Deny it if its effect is unclear.
- **Workspace cannot open:** check the folder exists and your OS account can access it.
- **CLI diagnostics:** run `oasis doctor` and share only relevant error text. Never paste API keys or runtime tokens into issues.

## Interactive terminal (PTY)

The interactive terminal uses Microsoft's optional `node-pty` native component. The desktop package rebuilds native dependencies for Electron; the CLI keeps this component optional so a native build problem does not block ordinary CLI startup.

Manual build prerequisites may be required:
- Debian/Ubuntu: `sudo apt install python3 make g++`
- macOS: `xcode-select --install`
- Windows: Visual Studio Build Tools with C++ desktop build tools and Windows SDK, plus Python
- Android/Termux: native PTY is not a guaranteed supported target

After prerequisites, a CLI user can retry with `npm rebuild node-pty`.

## Android / Termux

The CLI path can be tried in Termux. There is no native Android APK, and native PTY/background execution is experimental. Follow the dedicated [Termux guide](TERMUX.md) for setup and limits.

## Safety and support boundaries

OASIS runs approved commands with the current OS user's permissions. Approval prompts are not an operating-system sandbox. The optional OS sandbox is disabled by default and currently targets Linux and macOS (an opt-in Docker/Podman container backend covers every OS, including Windows); it is not full filesystem-read isolation. Windows OS isolation is not implemented. See [Security](../SECURITY.md), [Privacy](PRIVACY.md) and the [project plan](PROJECT_PLAN.md).
