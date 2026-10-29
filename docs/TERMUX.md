# OASIS on Android with Termux

This is the phone-first path for people using Android. The desktop app does not run inside Termux, and Android is not yet a fully verified support target. The command-line path is the part to try.

## 1. Install Termux

1. Open the official [Termux installation guide](https://github.com/termux/termux-app#installation).
2. Choose the F-Droid or GitHub release route listed there. Use one source consistently; do not mix Termux and its add-ons from different signing sources.
3. Open **Termux**. You will see a terminal and a keyboard. Tap the terminal area to type or paste.

## 2. Prepare Android

Copy and run each command separately. Tap the terminal, paste the command, then press **Enter**.

First update Termux's package list:

\`\`\`sh
pkg update
\`\`\`

If Termux asks whether to continue, read the package list and type `y` only when you are happy to proceed. Then install Node.js:

\`\`\`sh
pkg install nodejs
\`\`\`

Check the version:

\`\`\`sh
node --version
npm --version
\`\`\`

OASIS requires Node.js 22 or newer. If the Node.js version starts with a number lower than `v22`, stop here and update the Termux package, then check again. Do not run the OASIS installer until Node.js 22+ is available.

Git is optional for the archive-based installation.

## 3. Install OASIS

Open the [OASIS README](https://github.com/FAHTHIZ/oasis#two-ways-to-start) in your browser and use the **Install from the terminal** command. The README's one-line command downloads the installer, checks the script's SHA-256 against the published value, and asks before running it. Do not run a downloaded script if its checksum does not match.

The installer will:

- Check Node.js and npm.
- Offer to install the fixed OASIS release into your home folder (`~/.local`).
- Ask before installing OASIS or changing your shell's startup file.
- Run `oasis doctor` and open `oasis setup`.

During setup, choose a model provider and follow the on-screen questions. A hosted provider may send the prompts and code you choose to share to that provider. OASIS does not include a model or an API subscription. Do not paste API keys into public issues or chats.

If the installer says it cannot find Node.js 22+, follow its message and check `node --version` again before retrying.

## 4. Start and check OASIS

Open a new Termux session after setup, then run:

\`\`\`sh
oasis --version
oasis doctor
\`\`\`

To start an interactive session, run:

\`\`\`sh
oasis
\`\`\`

To start the browser workspace, run:

\`\`\`sh
oasis web
\`\`\`

Open the **local address printed in the terminal** in the browser on the same phone. Keep it bound to localhost; do not expose it to the Internet or an untrusted network.

## 5. Make the phone keyboard easier

Termux's extra-keys row provides keys such as **ESC**, **TAB**, **CTRL**, and arrow keys that are awkward on a phone keyboard.

1. Open Termux's left drawer.
2. Long-press the keyboard button to enable the extra keys row. Termux also documents **Volume Down + K** as a shortcut for the extra-keys row.
3. For a two-row layout, create or edit `~/.termux/termux.properties` and add:

\`\`\`properties
extra-keys = [['ESC','/','-','HOME','UP','END','PGUP'], ['TAB','CTRL','ALT','LEFT','DOWN','RIGHT','PGDN']]
\`\`\`

4. Save the file and run:

\`\`\`sh
termux-reload-settings
\`\`\`

You can keep the default layout if you prefer. The extra-keys row is a suggestion, not a requirement.

## What works, and what is not verified

- **CLI setup and basic coding tasks:** intended path to try on Android, subject to the Node.js and provider requirements above.
- **Browser workspace:** can be launched with `oasis web`; use the local address it prints.
- **Model choice:** hosted providers need their own access credentials; local inference depends on a model runtime and the phone's available memory and speed.
- **Desktop app:** Electron desktop installers are not available inside Termux.
- **Native terminal panel / PTY:** the optional native `node-pty` component is not a guaranteed supported Termux target. If a feature that relies on it is unavailable, use the regular CLI or browser path and share the exact `oasis doctor` output.
- **Background tasks:** Android may pause or stop apps in the background. Keep Termux open while a task is running, and avoid relying on long-running sessions until you have tested them on your device.
- **Isolation:** approval prompts are not a full operating-system sandbox. Review commands and file changes before approving them.

## If you get stuck

Run:

\`\`\`sh
oasis doctor
\`\`\`

Copy the relevant error text, but remove API keys, private paths or project details that you do not want to share. Include your Android version, Termux source (F-Droid or GitHub), and the outputs of `node --version` and `oasis --version`.
