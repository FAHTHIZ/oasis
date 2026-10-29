# Installing OASIS

## Desktop app — no terminal required

The desktop app is packaged by CI for Windows, macOS, and Linux. Open the [latest OASIS release](https://github.com/FAHTHIZ/oasis/releases/latest) and download the installer for your computer. It includes its application runtime, opens a project-folder picker, starts the OASIS backend on localhost, and connects the workspace automatically. You do not need to install Node.js or Git.

| Operating system | Download | First launch |
| --- | --- | --- |
| Windows 10/11, x64 | OASIS installer (.exe) | Double-click the installer. It installs for your user and adds Start Menu/Desktop shortcuts. |
| macOS | OASIS disk image (.dmg) | Open the disk image and drag OASIS into Applications. |
| Linux, x64 | OASIS .deb or AppImage | Open the .deb with your software installer, or run the AppImage from your desktop environment. |

**Release signing note:** builds are currently unsigned because signing certificates are not configured. Windows may show SmartScreen; macOS may require you to explicitly open an unverified application. Verify that the download came from the official OASIS GitHub release before proceeding.

On first launch, choose the folder for your project. The app will guide you to connect a model with one of three paths: an API key, a locally running OmniRoute gateway, or a model installed through Ollama on this computer. The API-key field is masked; the desktop app uses Electron's OS-backed secure storage and refuses to save a new key if encryption is unavailable. Test the provider before you start a coding task. OASIS does not include an AI model or an API subscription. See the [5-minute quickstart](QUICKSTART.md) for the exact clicks.

OmniRoute setup is not yet a fully automatic one-click installer; the current guide asks you to run `oasis setup` and choose OmniRoute first. That limitation will remain documented until the app can show the exact install plan and ask for approval before executing it.

## Command-line installation (optional)

The recommended CLI installer checks Node.js 22+, asks before installing or changing shell startup files, and installs the immutable source revision `27efc103994c26cab2331bb7037167372ceaa787` (package version `0.3.0`) into your user directory. It does not use administrator rights.

- **macOS, Linux, and Android/Termux:** copy the checksum-verifying one-line command from the [README](../README.md#install-from-the-terminal--macos-linux-or-androidtermux).
- **Windows PowerShell:** use the PowerShell one-liner in the [README](../README.md#install-from-the-terminal--macos-linux-or-androidtermux), which checks the script hash before running it.
- **Android-specific taps and known limits:** see [the Termux guide](TERMUX.md).

Installer checksums are printed in the README. If a hash does not match, stop and do not run the downloaded script. The installer runs `oasis doctor` and opens `oasis setup` after installation. npm publishing is not enabled yet; the source archive route remains the supported CLI bootstrap.

## Interactive terminal sessions (PTY)

Interactive sessions use Microsoft's `node-pty` native component. The desktop build recompiles native dependencies for Electron; the command-line install keeps the component optional so a native build problem cannot prevent the normal CLI from starting.

For manual CLI installation, native build prerequisites may be required:

- **Debian/Ubuntu:** `sudo apt install python3 make g++`.
- **macOS:** install Apple's Command Line Tools with `xcode-select --install`.
- **Windows:** install Visual Studio Build Tools with the C++ desktop build tools and Windows SDK, plus Python.
- **Android/Termux:** the desktop app is unavailable; the optional native PTY component is not a guaranteed supported install target yet.

To retry a native CLI build after installing the prerequisites, run `npm rebuild node-pty`.

## If installation fails

For the desktop app, report the exact operating system and installer filename. For manual CLI installation, run `oasis doctor` and include relevant error output. Never paste API keys or other secrets into public issues.
