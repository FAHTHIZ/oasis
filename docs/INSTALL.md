# Installing and starting OASIS

OASIS is Beta software. Use a project folder you trust, review permission prompts, and back up important work before testing unfamiliar code.

## Desktop app — no terminal required

> **Availability:** Desktop packages are built by CI, but there is currently no published GitHub Release or public desktop installer asset to download. The source package is version 0.4.0 and its notes are prepared, but `v0.4.0` has not been tagged or published. Use the CLI installation path below until a release with desktop assets is published.

The Electron app is configured for Windows, macOS and Linux. When public release assets are available, choose the matching file from the [GitHub releases page](https://github.com/FAHTHIZ/oasis/releases). The packaged app includes its own runtime: you do not need to install Node.js or Git separately. The first-launch guidance below describes the intended packaged-app flow.

| Operating system | Download | First launch |
|---|---|---|
| Windows 10/11, x64 | `.exe` installer | Run the installer. It installs for the current user and adds Start Menu/Desktop shortcuts. |
| macOS, Apple Silicon (arm64) | `.dmg` disk image | Open the image and drag OASIS into Applications. |
| Linux, x86_64 | `.AppImage` or `.deb` | Run the AppImage or open the package with your software installer. |

Desktop builds are currently unsigned. Verify downloads against the official GitHub release and the release `SHA256SUMS` file. Checksums detect transfer corruption; they are not a publisher signature. Automatic desktop updates are not configured.

On first launch:
1. Choose a project folder, not your entire home directory.
2. Open **Model provider** and choose an API key, an already-running OmniRoute-compatible gateway, or a local Ollama model.
3. For API keys, select the provider and enter the key into the masked field. The Electron app uses OS-backed secure storage and refuses to save a new key if encryption is unavailable.
4. For Ollama, install and start Ollama, download a model, and then select the model from OASIS.
5. Test the provider before starting a coding task. The provider probe checks whether the model can return an inert tool call; it never executes that tool.

The CLI guided setup can install OmniRoute through npm, request approval to start its local gateway, and verify tool calling before saving the provider. The desktop setup does not yet provide that entire gateway-install flow inside its UI; use an API key or an already-running local provider. OASIS does not include a model or paid subscription.

## Command-line installation

The supported installer resolves the latest stable versioned Git tag to an immutable commit SHA. It does not install the moving `main` branch. Node.js 22 or newer is required; on Termux, the installer can offer to install Node.js using `pkg`.

### macOS, Linux and Android/Termux

Use the checksum-verified shell installer bootstrap:

```sh
sh -c 'set -eu; f=$(mktemp "${TMPDIR:-/tmp}/oasis-install.XXXXXX"); cleanup() { rm -f "$f"; }; trap cleanup EXIT; trap "exit 1" HUP INT TERM; url=https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh; if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$f"; elif command -v wget >/dev/null 2>&1; then wget -qO "$f" "$url"; else echo "Install curl or wget first, then retry." >&2; exit 1; fi; expected=3d2c26fce56885b9ae7a62274b9e5bb8f54510836e3cff68c87cc91b9dede181; if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$f"); actual=${actual%% *}; elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$f"); actual=${actual%% *}; elif command -v openssl >/dev/null 2>&1; then actual=$(openssl dgst -sha256 "$f"); actual=${actual##*= }; else echo "No SHA-256 tool found; see docs/INSTALL.md"; rm -f "$f"; exit 1; fi; if [ "$actual" != "$expected" ]; then echo "Installer checksum mismatch. Do not run it."; rm -f "$f"; exit 1; fi; if sh "$f"; then code=0; else code=$?; fi; rm -f "$f"; exit "$code"'
```

**Installer SHA-256:** `3d2c26fce56885b9ae7a62274b9e5bb8f54510836e3cff68c87cc91b9dede181`

### Windows PowerShell

Download and verify both the installer and resolver helper before running:

```powershell
$d=Join-Path $env:TEMP ('oasis-install-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force -Path $d | Out-Null; $p=Join-Path $d 'install.ps1'; $h=Join-Path $d 'release-resolution.ps1'; try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.ps1' -OutFile $p; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/release-resolution.ps1' -OutFile $h; $expected='46ac435b8c2d0f68504ac2bec8b8fa0f9786c073f670a6980e56315d50650a3e'; $actual=(Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant(); $helperExpected='a88ec877205ab792310c04179f702ceff13bfb3adb5d2d58345bb70fc459a19d'; $helperActual=(Get-FileHash $h -Algorithm SHA256).Hash.ToLowerInvariant(); if($actual -ne $expected -or $helperActual -ne $helperExpected){throw 'Installer checksum mismatch. Do not run either file.'}; & $p; $code=$LASTEXITCODE } finally { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }; if ($null -ne $code) { exit $code }
```

**Windows installer SHA-256:** `46ac435b8c2d0f68504ac2bec8b8fa0f9786c073f670a6980e56315d50650a3e`  
**Windows resolver helper SHA-256:** `a88ec877205ab792310c04179f702ceff13bfb3adb5d2d58345bb70fc459a19d`

If any checksum differs, do not run the downloaded file. The installer sets up the CLI, runs `oasis doctor` and opens guided provider setup. npm publishing is not enabled; the source-archive install path is used.

After installation, `oasis update` checks the latest stable release, resolves it to an immutable commit and asks before replacing the CLI. `oasis uninstall` asks before removing the CLI and retains projects, settings, saved sessions, memory and API keys.

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

OASIS runs approved commands with the current OS user's permissions. Approval prompts are not an operating-system sandbox. The optional OS sandbox is disabled by default and currently targets Linux and macOS; it is not full filesystem-read isolation. Windows OS isolation is not implemented. See [Security](../SECURITY.md), [Privacy](PRIVACY.md) and the [project plan](PROJECT_PLAN.md).
