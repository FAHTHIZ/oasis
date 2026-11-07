# Changelog

User-facing change history grouped by package version. A version heading does not imply that a GitHub Release or downloadable assets have been published; check the [Releases page](https://github.com/FAHTHIZ/oasis/releases) for current availability.

## Unreleased

- Corrected release documentation to distinguish Git tags, CI artifacts and published GitHub Release assets.
- Updated the repository inventory and architecture notes after the first provider-stream extraction.
- Added a reproducible, caveated comparison of repository presentation and engineering practices against a 100-project AI-agent reference set.

- `glob_files` and `search_files` find files anywhere in large repositories; they previously stopped after the first 1,800–5,000 files. `search_files` now uses ripgrep.
- `grep` accepts ripgrep-style arguments (`-i`, `-A`, `-B`, `-C`, `head_limit`) and adds `type`, `before`, `after` and `offset`.
- One provider registry drives setup, `configure_provider`, fallback models and local-server discovery; user settings can add or re-point providers ([configuration reference](docs/CONFIGURATION.md)). `configure_provider` now accepts every known provider instead of five.
- Output token limits come from the models.dev catalog, so models such as the default `gpt-6.1-sol`, gpt-oss, GLM-5 and MiniMax-M2 get 32,000 tokens per response instead of 8,192.
- `read_file`, `edit_file`, `multi_edit` and `write_file` read and preserve UTF-16 files with a byte order mark instead of rejecting them as binary.
- `run_command` and `run_shell` leave out passing-test timing blocks, repeated test headers, npm update banners and progress redraws; failures keep every line and the raw output stays in `.oasis/command-logs/`. A passing 20-test `npm test` result shrinks from 1,140 to 508 tokens ([command output](docs/CONFIGURATION.md#command-output)).
- Command logs in `.oasis/command-logs/` no longer show up in `git status`, `git_diff` or `git add -A`; the directory now gets a `.gitignore`.
- `grep` shows matches that sit deep inside long lines (minified bundles, generated JSON) as a window around the match; before, it showed the first 400 columns, which often did not include the match.
- Reasoning replay follows the models.dev `interleaved` field, so GLM, MiMo and other interleaved-thinking models get their `reasoning_content` back between tool calls (previously only names containing deepseek, moonshot or kimi). A `replayReasoning` config value overrides it. The bundled catalog snapshot was refreshed.
- The token benchmark (`bench/tokens`) counts tokens with the same o200k BPE counter the runtime uses instead of characters / 4; the baseline was regenerated (taskflow-search ~162.7k, normalize-token-usage ~256.2k input tokens).

## 1.1.0

- Added desktop update notifications and checksum verification before installing release assets.
- Improved first-run setup with hardware-aware model and provider recommendations.
- Added LAN links and QR-based access for phone and tablet workflows, plus installable browser-app support.
- Expanded optional desktop builds for macOS Intel, Linux ARM64 and Windows ARM64 when the corresponding CI jobs succeed.
- Improved usage and local-model cost reporting, context management and harness evaluation workflows.

## 1.0.0

- First stable public release of the OASIS coding-agent runtime and desktop application.
