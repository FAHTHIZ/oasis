# OASIS on Android with Termux

This is the phone-first path for people using Android. The Electron desktop app does not run inside Termux, and Android is not yet a fully verified support target. The command-line path is the one to try.

## 1. Install Termux

1. Open the official [Termux installation guide](https://github.com/termux/termux-app#installation).
2. Choose the F-Droid or GitHub release route listed there. Use one source consistently; do not mix Termux and add-ons from different signing sources.
3. Open **Termux**. Tap the terminal area to type or paste commands.

## 2. Install OASIS with one command

Paste this single command into Termux and press **Enter**:

```sh
sh -c 'f=$(mktemp) || exit; curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh -o "$f" && sh "$f"; r=$?; rm -f "$f"; exit "$r"'
```

The installer checks for Node.js 22 or newer. If it is missing, it offers to install Node.js with Termux's package manager. It then downloads the latest stable GitHub release of OASIS, installs it in your user folder, checks the environment, and starts guided provider setup. You do not need to clone the repository, install Git, or type separate npm commands.

The easy command runs the installer from the official repository over HTTPS. For an additional SHA-256 check, use the verified command in the [README](../README.md#install-from-the-terminal--macos-linux-or-androidtermux).

During provider setup, choose the free OmniRoute gateway to let OASIS offer to install the gateway through npm, start it locally, and verify the model connection. Read each approval prompt; npm packages may run third-party install scripts. A free gateway may be limited or unavailable, and OASIS does not include an AI model or subscription. You can instead choose a provider for which you already have an API key.

Keep Termux open until installation and provider verification finish. If the installer says it added the OASIS command folder to your shell startup file, open a new Termux session before using `oasis`.

## 3. Start OASIS

In a new Termux session, check the installation and start OASIS:

```sh
oasis --version
oasis doctor
oasis
```

To start the browser workspace:

```sh
oasis web
```

Open the **local address printed in the terminal** in the browser on the same phone. Keep it on localhost; do not expose it to the Internet or an untrusted network.

## 5. Optional phone keyboard shortcuts

Termux's extra-keys row makes **ESC**, **TAB**, **CTRL**, and arrow keys easier to use on a phone.

For a two-row layout, create or edit `~/.termux/termux.properties` and add:

```properties
extra-keys = [['ESC','/','-','HOME','UP','END','PGUP'], ['TAB','CTRL','ALT','LEFT','DOWN','RIGHT','PGDN']]
```

Save the file and apply the setting:

```sh
termux-reload-settings
```

This keyboard layout is optional. Use the layout you prefer.

## What works, and what is not verified

- **CLI setup and coding tasks:** intended path to try on Android, subject to Node.js and provider requirements.
- **Browser workspace:** can start with `oasis web`; use the local address it prints.
- **Desktop app:** Electron installers do not run inside Termux.
- **Native terminal / PTY:** `node-pty` is optional and is not a guaranteed supported Termux target. Use the ordinary CLI or browser path if it does not work.
- **Background tasks:** Android may pause apps in the background. Keep Termux open while a task runs until you have confirmed your device handles it reliably.
- **Isolation:** approval prompts are not a full operating-system sandbox. Review commands and file changes before approving.

## If you get stuck

Run `oasis doctor` and copy only the relevant error text. Remove API keys, private paths, and project details you do not want to share. Include your Android version, Termux source (F-Droid or GitHub), and the outputs of `node --version` and `oasis --version`.
