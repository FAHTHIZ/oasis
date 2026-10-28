# OASIS for VS Code

Connects the OASIS CLI to VS Code (and forks such as Cursor and Windsurf), like Claude Code's IDE integration.

- **Chat panel**: an OASIS view in the activity bar (Ctrl/Cmd+Shift+Esc), or `OASIS: Open Chat in Editor` for a tab. Streaming replies, inline tool calls, Allow / Always allow / Deny approval cards, Stop (Esc) and New chat. `OASIS: Add Selection to Chat` (Ctrl/Cmd+Alt+L) adds an `@path#L` reference. It runs `oasis -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio` in the workspace folder; set `oasis.command` if `oasis` is not on PATH.
- **Selection context**: whatever you select (or the file you are in) is shared with the agent on each prompt.
- **Diff review**: proposed `edit_file` / `multi_edit` / `write_file` changes open in VS Code's diff view; click **Accept** or **Reject**.
- **Diagnostics**: the agent can read the editor's errors and warnings with `ide_get_diagnostics`, and open files at a line with `ide_open_file`.
- **Commands**: `OASIS: Run in Terminal` (Ctrl/Cmd+Esc), `OASIS: Insert File Reference` (Ctrl/Cmd+Alt+K inserts `@path#L10-20`), `OASIS: Continue Last Session`.

Install: run `oasis ide install` (builds the VSIX and installs it with `code`, `cursor`, `windsurf` or `code-insiders`), or `oasis ide package` to just build `oasis-vscode.vsix`.

Running `oasis` in any VS Code integrated terminal connects automatically. From another terminal, run `/ide` inside OASIS. The bridge listens on 127.0.0.1 only, requires a random bearer token stored in a 0600 lock file under the OASIS config directory, and rejects browser origins.
