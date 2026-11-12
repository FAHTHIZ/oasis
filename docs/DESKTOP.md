# Desktop app

The OASIS desktop app is the same runtime as the `oasis` command, in its own
window. It starts the web workspace on this computer (loopback only, port
47615, or a random free port if that one is taken) and shows it in an
Electron window. Sessions, settings, skills and plugins are shared with the
CLI, and the terminal agent and `oasis web` keep working on their own: you do
not need the desktop app, and installing it does not change them.

## Download

Installers are attached to each [GitHub Release](https://github.com/FAHTHIZ/oasis/releases)
together with a `SHA256SUMS` file:

| Platform | File | Install |
| --- | --- | --- |
| Windows 10/11 (x64, ARM64) | `OASIS-<version>-x64.exe`, `OASIS-<version>-arm64.exe` | Run it. It installs for your user only (no administrator prompt) and adds Start menu and desktop shortcuts. |
| macOS (Apple Silicon, Intel) | `OASIS-<version>-arm64.dmg`, `OASIS-<version>-x64.dmg` | Open the disk image and drag OASIS into Applications. See [macOS first launch](#macos-first-launch). |
| Linux (x64, ARM64) AppImage | `OASIS-<version>-x86_64.AppImage`, `OASIS-<version>-arm64.AppImage` | `chmod +x OASIS-*.AppImage && ./OASIS-*.AppImage` |
| Debian, Ubuntu (x64, ARM64) | `OASIS-<version>-amd64.deb`, `OASIS-<version>-arm64.deb` | `sudo apt install ./OASIS-<version>-amd64.deb`, then start **OASIS** from the app menu or run `oasis-desktop`. |

ARM64 Linux and Windows and Intel macOS builds are made on a best-effort basis:
if one fails to build, the release ships without it rather than waiting.

Verify a download before running it:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

On Windows PowerShell: `Get-FileHash .\OASIS-<version>-x64.exe -Algorithm SHA256`,
then compare with the matching line in `SHA256SUMS`.

### Code signing

The installers are not signed with an Apple Developer ID or a Windows
code-signing certificate yet. This is stated plainly so the warnings below are
expected rather than alarming:

- **Windows** SmartScreen may say "Windows protected your PC". Choose
  **More info → Run anyway** after checking the file against `SHA256SUMS`.
- **macOS** builds are signed ad hoc (Apple Silicon requires a signature to
  run), but not notarized.

### macOS first launch

macOS blocks apps from the internet that are not notarized and may say the app
"is damaged" or "cannot be opened". After dragging OASIS into Applications and
checking the download against `SHA256SUMS`, remove the download quarantine
once:

```sh
xattr -dr com.apple.quarantine /Applications/OASIS.app
```

Then open OASIS normally. Updates installed by the app itself do not need this
again unless macOS quarantines the new disk image.

## First run

1. Choose a project folder. OASIS works only inside the folder you pick, and
   reopens it next time. **File → Open project folder…** (Ctrl/Cmd+O) switches.
2. Paste a model key, a model page link or a local server address (for
   example `http://localhost:11434` for Ollama) into **Paste a key to start**.
   OASIS checks that the model can call tools before saving it.
3. Describe a task. As in the browser and terminal, commands and network
   access ask first; file edits are checkpointed, so **Undo** reverts them.

## Where your key is stored

- **macOS, Windows, and Linux with a keyring** (GNOME Keyring, KWallet): the
  key is encrypted with the operating system's key store through Electron
  `safeStorage` and saved as `secure-secrets.json` in the app's data folder.
  `config.json` keeps only the non-secret provider details.
- **Linux without a keyring**: Electron would fall back to a hard-coded
  password, which OASIS does not treat as protected. The key is kept the way
  the CLI keeps it: in `config.json` with owner-only (0600) permissions.
- A key that the CLI saved in `config.json` moves into the key store the first
  time the desktop app starts, unless it came from an environment variable.

The key is never sent back to the page and never written to logs.

## Updates

The app checks GitHub Releases for a newer stable version a short while after
it starts and then every few hours (turn off with `OASIS_NO_UPDATE_CHECK=1`).
**Help → Check for updates…** checks now. Before anything runs, the downloaded
installer must match the release's `SHA256SUMS`. You are always asked first.

| Installed from | What **Install and restart** does |
| --- | --- |
| Windows installer | Runs the new installer silently and reopens OASIS. |
| AppImage | Replaces the AppImage file in place and restarts. |
| `.deb` | Opens the new package in your system installer (or run `sudo apt install <file>`). |
| macOS disk image | Opens the new disk image for you to drag into Applications. |

Projects, chats, settings and keys are kept across updates.

## Data folders

| Platform | App data (window state, encrypted key, update state) | OASIS settings and sessions (shared with the CLI) |
| --- | --- | --- |
| Windows | `%APPDATA%\OASIS` | `%APPDATA%\oasis` |
| macOS | `~/Library/Application Support/OASIS` | `~/.config/oasis` |
| Linux | `~/.config/OASIS` | `~/.config/oasis` |

`OASIS_DESKTOP_USER_DATA=/some/folder` starts the app with a separate app-data
folder (useful for testing a clean first run).

## Uninstall

- **Windows**: Settings → Apps → OASIS → Uninstall. Your data folders are kept.
- **macOS**: drag `/Applications/OASIS.app` to the Trash.
- **AppImage**: delete the file.
- **Debian/Ubuntu**: `sudo apt remove oasis-desktop`.

To remove everything, also delete the data folders above. Deleting
`~/.config/oasis` (or `%APPDATA%\oasis`) also removes the CLI's settings and
sessions.

## Security model

The window loads only the local workspace origin, with `contextIsolation`,
`sandbox` and no Node.js in the page. Links to other sites open in your
browser. Only microphone (for dictation), notifications, fullscreen and
clipboard writes are allowed; camera, location, USB, serial, HID and screen
capture are refused. The workspace server listens on `127.0.0.1` only, with
the same per-launch token as `oasis web`.

## Recovery

- If the window's page crashes, a recovery screen offers **Reload**; the
  workspace and running tasks keep going in the background.
- If the last project folder is gone, OASIS asks for another one.
- If startup fails, the error can be copied from the dialog. `oasis doctor` in
  a terminal checks the same runtime.

## Build it yourself

```sh
npm ci                     # the runtime
cd desktop && npm ci       # Electron and electron-builder (kept out of the CLI package)
node scripts/build.mjs --linux AppImage deb --x64    # or --win nsis --x64, --mac dmg --arm64
node scripts/smoke.mjs     # launches the built app and checks its workspace answers
```

`desktop/scripts/build.mjs` copies the runtime and the desktop shell into
`desktop/.stage`, installs the exact production dependencies from the root
lockfile, and runs electron-builder. Installers land in `release/`.
`npm run dev` in `desktop/` stages and starts the app without packaging.
With `CSC_LINK`/`CSC_KEY_PASSWORD` (and Apple notarization credentials) set,
electron-builder signs and notarizes instead of signing ad hoc.
