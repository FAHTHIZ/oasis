# Downloads and releases

OASIS ships as the `oasis` command, which runs the terminal agent and serves the web workspace (`oasis web`), and as an optional [desktop app](DESKTOP.md) built from the same runtime. Any modern browser on any device is also an interface; there is no separate mobile app.

Releases are published on [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases). Each release carries the npm tarball (`oasis-oss-<version>.tgz`), the desktop installers (Windows `.exe`, macOS `.dmg`, Linux `.AppImage` and `.deb`) a CycloneDX SBOM (`oasis-oss-<version>.cdx.json`) and a `SHA256SUMS` file covering all of them. Every asset also has a signed [SLSA build provenance](https://slsa.dev/spec/v1.0/provenance) attestation, and the tarball has a signed SBOM attestation.

## Install

| Platform | Command |
| --- | --- |
| macOS, Linux | `curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh \| sh` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.ps1 \| iex` |
| Homebrew | `brew tap fahthiz/oasis https://github.com/FAHTHIZ/oasis && brew install fahthiz/oasis/oasis-cli` |
| Release tarball | `npm install --global ./oasis-oss-<version>.tgz` |
| From source | `git clone https://github.com/FAHTHIZ/oasis.git && cd oasis && npm install && npm install --global .` |

All methods need Node.js 22.19 or newer and Git.

## Verify a download

On macOS or Linux:

```sh
shasum -a 256 -c SHA256SUMS
```

On Windows PowerShell, compare the output with the matching line in `SHA256SUMS`:

```powershell
Get-FileHash .\oasis-oss-<version>.tgz -Algorithm SHA256
```

Only install files attached to a GitHub Release. Temporary GitHub Actions artifacts are not releases.

### Check where a file was built

A checksum shows that a file matches `SHA256SUMS`. It does not show where either came from. The attestations do: each one is an [in-toto statement](https://github.com/in-toto/attestation) signed with a short-lived [Sigstore](https://www.sigstore.dev/) certificate bound to the release workflow run, naming the commit, the workflow file and the runner that built the file. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify oasis-oss-<version>.tgz -R FAHTHIZ/oasis
gh attestation verify oasis-oss-<version>.tgz -R FAHTHIZ/oasis --predicate-type https://cyclonedx.org/bom
```

The first checks the build provenance, the second the SBOM attestation. Add `--signer-workflow FAHTHIZ/oasis/.github/workflows/release.yml` to refuse a file attested by any other workflow. Files from releases published before attestations were added have none; for those, only the checksum applies.

### SBOM

`oasis-oss-<version>.cdx.json` is a [CycloneDX 1.6](https://cyclonedx.org/specification/overview/) SBOM of every package an install of that tarball resolves from `package-lock.json`, written by `scripts/sbom.mjs`. Each component has its purl, license, registry tarball URL and the lockfile's SHA-512 integrity hash; optional platform packages (`node-pty`, `sharp`, `modal`) are marked `optional`; the dependency graph follows Node's resolution, so two versions of one package are both listed with who uses each. Dev-only packages are not shipped and not listed. The SBOM is deterministic (sorted, with a serial number derived from the lockfile and a timestamp from the commit date), so anyone can regenerate it from the tag and compare bytes:

```sh
git checkout v<version>
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" node scripts/sbom.mjs --out mine.cdx.json
cmp mine.cdx.json oasis-oss-<version>.cdx.json
```

`node scripts/sbom.mjs --check [FILE]` compares an SBOM with what is actually under `node_modules` and exits 1 on a missing package, a different version, or a package the SBOM does not list. It reads `package.json` files only and never runs package code.

### Reproducible tarball

The release job packs the tarball twice and fails if the two digests differ, so a nondeterministic step (a timestamp, an unordered directory listing, a download during `prepack`) is caught before it ships.

### What `oasis update` checks

On an npm install, `oasis update` installs the release's own npm tarball (`oasis-oss-VERSION.tgz`, the file the release job packed twice and attested), not a GitHub source archive. Before npm sees it, OASIS:

1. checks its SHA-256 against the release's `SHA256SUMS`;
2. reads `package/package.json` from inside it and requires `oasis-oss` at the release's version, so a valid file from an older release (a downgrade) or another package is refused;
3. when the GitHub CLI is installed, runs `gh attestation verify` pinned to this repository's release workflow, the release tag (`--source-ref refs/tags/vX.Y.Z`), the release commit (`--source-digest`) and GitHub-hosted runners. A verification that fails blocks the install.

The update prints each result. `SHA256SUMS` comes from the same release, so on its own it catches corruption and truncation; the signed provenance is what ties the file to the release workflow. Releases made before attestations existed, or machines without `gh`, get the first two checks and a note that provenance was not verified. `OASIS_UPDATE_REQUIRE_PROVENANCE=1` refuses any update whose provenance could not be verified. Git checkouts update by fetching the tag and checking out its commit, and Homebrew installs go through `brew upgrade`, which checks the formula's own SHA-256.

## How releases are published

`.github/workflows/release.yml`:

1. Installs dependencies and runs the quick quality gate.
2. Packs the npm tarball and installs it into a clean prefix as a smoke test.
3. Builds the desktop installers on Windows, macOS and Linux runners, runs the desktop unit tests, and launches each packaged app to check that its workspace answers. This runs on every push to `main`, so a broken desktop build shows up before a release.
4. Waits for the same commit's `quality.yml` and `installer-checks.yml` runs to pass.
5. Checks that a second `npm pack` gives the same digest, writes the SBOM and checks it against the installed `node_modules`.
6. Attests SLSA build provenance for every asset listed in `SHA256SUMS` and the SBOM for the tarball, then publishes the versioned GitHub Release with every installer, the SBOM and `SHA256SUMS`.
7. For stable releases, refreshes `Formula/oasis-cli.rb` on `main`.
8. Publishes the same tarball to npm as `oasis-oss`, with [provenance](https://docs.npmjs.com/generating-provenance-statements), when the `NPM_TOKEN` secret exists. Without it the step is skipped with a notice. Release candidates go to the `next` tag.

The package version and release tag must match, and `package.json` `oasisRelease.channel` must be `stable`.

## Turning on npm and code signing

Everything is wired; each piece switches on when its repository secret exists (Settings → Secrets and variables → Actions, or `gh secret set NAME`). Nothing is signed or published with placeholder credentials.

| Secret | What it enables |
| --- | --- |
| `NPM_TOKEN` | An npm automation token for an account that owns (or can create) `oasis-oss`. After the first publish, `npm install -g oasis-oss` works. |
| `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD` | A base64-encoded Developer ID Application `.p12` (`base64 -i cert.p12 \| pbcopy`) and its password. macOS builds are then signed with the hardened runtime instead of ad hoc. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization with an app-specific password from appleid.apple.com. With these, Gatekeeper opens the app without the `xattr` step in [DESKTOP.md](DESKTOP.md). |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | A base64-encoded `.pfx` code-signing certificate. Signed installers build SmartScreen reputation instead of showing "Windows protected your PC". |

The certificates are passed to electron-builder only on their own platform's runner, and the raw secret variables are unset before the build runs.
