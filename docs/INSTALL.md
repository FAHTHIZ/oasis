# Installing OASIS

OASIS is currently shipped as a CLI and local browser workspace. A signed desktop installer that installs everything without opening a terminal is **not released yet**; we are not presenting a terminal command as a one-click graphical installer.

## Quick install (Node.js 22 or newer)

Open a terminal in your operating system, paste this single command, and press Enter:

```sh
npm install --global https://github.com/FAHTHIZ/oasis/archive/refs/heads/main.tar.gz
```

Then start OASIS:

```sh
oasis
```

This archive-based install does not require Git. The first launch guides you through model-provider setup. OASIS does not include an AI model or paid API subscription.

## Real terminal sessions (PTY)

Interactive sessions use Microsoft's `node-pty` native component. It is an optional dependency so OASIS's normal CLI continues to run if native compilation is unavailable. Standard non-interactive commands still work in that case, but `run_command` with `interactive=true` will report that the PTY component could not be loaded.

The upstream component supports Linux, macOS and Windows, but its build may require native tools:

- **Debian/Ubuntu:** `sudo apt install python3 make g++` (and a supported Node.js 22+ installation).
- **macOS:** install Apple's Command Line Tools with `xcode-select --install`.
- **Windows:** install Visual Studio Build Tools with the C++ desktop build tools and Windows SDK, plus Python.
- **Android/Termux:** the native PTY component is not a guaranteed supported install target yet; the standard argv command runner remains the fallback.

After the native prerequisites are available, rebuild it with:

```sh
npm rebuild node-pty
```

If OASIS was installed globally, run the rebuild from its global package directory or reinstall OASIS after installing the prerequisites. We are working toward signed OS-specific installers so new users will not need to handle Node.js, compilers, or terminal commands themselves.

## If installation fails

Run `oasis doctor` to check the Node.js runtime and configuration. For PTY-specific build problems, include the complete `npm rebuild node-pty` error when reporting an issue. Never paste API keys or other secrets into public issues.
