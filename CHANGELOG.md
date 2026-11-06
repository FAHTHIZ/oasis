# Changelog

User-facing highlights for published stable releases. See the linked GitHub release for the release description and downloadable assets.

## Unreleased

- `glob_files` and `search_files` find files anywhere in large repositories; they previously stopped after the first 1,800–5,000 files. `search_files` now uses ripgrep.
- `grep` accepts ripgrep-style arguments (`-i`, `-A`, `-B`, `-C`, `head_limit`) and adds `type`, `before`, `after` and `offset`.
- One provider registry drives setup, `configure_provider`, fallback models and local-server discovery; user settings can add or re-point providers ([configuration reference](docs/CONFIGURATION.md)). `configure_provider` now accepts every known provider instead of five.
- Output token limits come from the models.dev catalog, so models such as the default `gpt-6.1-sol`, gpt-oss, GLM-5 and MiniMax-M2 get 32,000 tokens per response instead of 8,192.
- `read_file`, `edit_file`, `multi_edit` and `write_file` read and preserve UTF-16 files with a byte order mark instead of rejecting them as binary.
- The token benchmark (`bench/tokens`) counts tokens with the same o200k BPE counter the runtime uses instead of characters / 4; the baseline was regenerated (taskflow-search ~162.7k, normalize-token-usage ~256.2k input tokens).

## [1.1.0](https://github.com/FAHTHIZ/oasis/releases/tag/v1.1.0)

- Added desktop update notifications and checksum verification before installing release assets.
- Improved first-run setup with hardware-aware model and provider recommendations.
- Added LAN links and QR-based access for phone and tablet workflows, plus installable browser-app support.
- Expanded optional desktop builds for macOS Intel, Linux ARM64 and Windows ARM64 when the corresponding CI jobs succeed.
- Improved usage and local-model cost reporting, context management and harness evaluation workflows.

## [1.0.0](https://github.com/FAHTHIZ/oasis/releases/tag/v1.0.0)

- First stable public release of the OASIS coding-agent runtime and desktop application.
