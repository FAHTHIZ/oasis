# OASIS for VS Code

Connects the OASIS CLI to VS Code (and forks such as Cursor and Windsurf), like Claude Code's IDE integration.

- **Selection context**: whatever you select (or the file you are in) is shared with the agent on each prompt.
- **Diff review**: proposed `edit_file` / `multi_edit` / `write_file` changes open in VS Code's diff view; click **Accept** or **Reject**.
- **Diagnostics**: the agent can read the editor's errors and warnings with `ide_get_diagnostics`, and open files at a line with `ide_open_file`.
- **Commands**: `OASIS: Run in Terminal` (Ctrl/Cmd+Esc), `OASIS: Insert File Reference` (Ctrl/Cmd+Alt+K inserts `@path#L10-20`), `OASIS: Continue Last Session`.

Install: run `oasis ide install` (builds the VSIX and installs it with `code`, `cursor`, `windsurf` or `code-insiders`), or `oasis ide package` to just build `oasis-vscode.vsix`.

Running `oasis` in any VS Code integrated terminal connects automatically. From another terminal, run `/ide` inside OASIS. The bridge listens on 127.0.0.1 only, requires a random bearer token stored in a 0600 lock file under the OASIS config directory, and rejects browser origins.
