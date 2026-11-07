# Downloads and releases

OASIS publishes installable desktop packages through [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases). The latest release page is the only source of truth for downloadable versions and platform assets.

## Desktop packages

| Platform | Primary asset | Architecture |
|---|---|---|
| Windows | NSIS .exe installer | x64; ARM64 when the optional build succeeds |
| macOS | .dmg disk image | Apple Silicon arm64; Intel x64 when the optional build succeeds |
| Linux | .AppImage and .deb | x64; ARM64 when the optional build succeeds |

The optional architecture jobs are best-effort. A missing optional asset means that build did not produce a package for that release; do not assume every release contains every architecture.

## Verify downloads

Each published release includes SHA256SUMS.

On macOS or Linux:

```sh
shasum -a 256 -c SHA256SUMS
```

On Windows PowerShell, calculate the downloaded file's hash and compare it with the matching entry in SHA256SUMS:

```powershell
Get-FileHash .\\your-downloaded-installer.exe -Algorithm SHA256
```

Only install assets attached to the GitHub Release. A Git tag, source archive, build log or temporary GitHub Actions artifact is not a published installer.

## Homebrew

The release workflow refreshes the project tap after a stable release:

```sh
brew tap fahthiz/oasis https://github.com/FAHTHIZ/oasis
brew install --cask fahthiz/oasis/oasis
brew install fahthiz/oasis/oasis-cli
```

The desktop cask installs the macOS application. The formula installs the terminal CLI and requires Homebrew's Node.js dependency.

## Terminal installation

For source-based CLI installation, use Node.js 22.15 or newer and Git:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
```

Then run oasis in a project directory. See the [user guide](USER-GUIDE.md#terminal-session).

## Browser and mobile access

The browser workspace is served by the OASIS process running on the computer that owns the project. It is not a public hosted service.

For a phone or tablet, follow [Mobile and tablet setup](../MOBILE.md) and use a trusted private network. There is no native Android APK or iOS App Store package in this release. Advanced Android users can run the CLI manually in Termux; this is not a one-click mobile installer.

## How releases are published

The desktop workflow:
1. Runs the source quality gate.
2. Builds platform installers on their matching runners.
3. Collects the generated packages and creates SHA256SUMS.
4. Waits for the same commit's quality and installer-check workflows.
5. Publishes the versioned GitHub Release.
6. Refreshes the Homebrew cask and CLI formula for stable releases.

The package version and release tag must match. Release assets are not advertised as available until GitHub reports the published release and its files.
