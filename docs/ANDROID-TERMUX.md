# Android / Termux (experimental)

OASIS's terminal CLI can run directly on Android inside [Termux](https://termux.dev/). This is an **experimental platform path**, not a native Android app. The web workspace can also be opened in an Android browser while the OASIS runtime is running on the device.

## Install

Open Termux and run:

```sh
pkg update
pkg install curl
curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh | sh
```

The installer checks for Node.js 22.19 or newer. When it detects Termux and Node.js is missing or too old, it offers to run `pkg install nodejs`; it does not install the package without your approval. OASIS is installed under your Termux home directory, not system-wide, and the installer finishes with `oasis doctor` and first-run model setup.

After installation, open a new Termux session so the updated PATH is loaded. With the default install prefix, you can also add it to the current shell with:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then:

```sh
oasis doctor
oasis connect
cd /path/to/your/project
oasis
```

Git is **not required to install the released CLI** this way. It is recommended for projects that use Git-based workflows, and is required if you choose to install OASIS from a source checkout.

## What to expect

- The terminal CLI is the primary on-device interface. To use the web workspace, start `oasis web` and open the localhost address it prints in your Android browser.
- Optional native components such as the PTY used by the web terminal may not be available on every Android/Termux build. OASIS reports optional component status in `oasis doctor`; the web terminal can fall back to line mode.
- Android is not currently part of the automated Linux/macOS/Windows CI matrix. Treat Termux support as experimental and report platform-specific problems with the output of `oasis doctor` (remove API keys and private paths first).

## Run the Termux smoke check

For a checkout of the OASIS source repository, run this from its root:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
sh scripts/termux-smoke.sh
```

The smoke check installs production dependencies into that checkout, checks CLI startup and the environment, verifies the isolated QuickJS workflow runtime, and reports whether optional native PTY support loaded. It does not contact a model provider. The source checkout is only needed for this diagnostic; it is not required for the normal release installation above.

## If the command is not found

Open a new Termux session first. If `oasis` is still not on PATH, check that `$HOME/.local/bin` is included:

```sh
printf '%s\n' "$PATH"
export PATH="$HOME/.local/bin:$PATH"
```

Run `oasis doctor` again after the command starts. It distinguishes a missing Node.js runtime from optional tools and model setup that still need attention.
