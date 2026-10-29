# OASIS on Android with Termux

This is the phone-first path for people using Android. The Electron desktop app does not run inside Termux, and Android is not yet a fully verified support target. The command-line path is the one to try.

## 1. Install Termux

1. Open the official [Termux installation guide](https://github.com/termux/termux-app#installation).
2. Choose the F-Droid or GitHub release route listed there. Use one source consistently; do not mix Termux and add-ons from different signing sources.
3. Open **Termux**. Tap the terminal area to type or paste commands.

## 2. Prepare Android

Run the commands below one at a time. Tap the terminal, paste a command, then press **Enter**.

`@`@`sh
pkg update
`@`@`

Read the package list before accepting. Then install Node.js:

`@`@`sh
pkg install nodejs
node --version
npm --version
`@`@`

OASIS requires Node.js 22 or newer. If the version is below 22, update Termux's Node.js package and check again before continuing. Git is optional for this archive-based installation.

## 3. Install OASIS

The one-line command in the README downloads `scripts/install.sh` from the official repository, checks the SHA-256 against the published README value, and only then runs it. If the checksum does not match, **stop**; do not run the script.

The installer uses immutable source revision `27efc103994c26cab2331bb7037167372ceaa787` (package version `0.3.0`), asks before installing OASIS into your home directory (`~/.local`) or changing your shell's startup file, then runs the environment check and opens setup. It then runs `oasis doctor` and opens `oasis setup`.

A hosted provider may receive the prompts and code you choose to send to it. OASIS does not include a model or an API subscription. Never share API keys in public issues, screenshots, or chat.

## 4. Start and check

Open a new Termux session after setup, then run:

`@`@`sh
oasis --version
oasis doctor
oasis
`@`@`

To start the browser workspace:

`@`@`sh
oasis web
`@`@`

Open the **local address printed in the terminal** in the browser on the same phone. Keep it on localhost; do not expose it to the Internet or an untrusted network.

## 5. Optional phone keyboard shortcuts

Termux's extra-keys row makes **ESC**, **TAB**, **CTRL**, and arrow keys easier to use on a phone.

For a two-row layout, create or edit `~/.termux/termux.properties` and add:

`@`@`properties
extra-keys = [['ESC','/','-','HOME','UP','END','PGUP'], ['TAB','CTRL','ALT','LEFT','DOWN','RIGHT','PGDN']]
`@`@`

Save the file and apply the setting:

`@`@`sh
termux-reload-settings
`@`@`

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
