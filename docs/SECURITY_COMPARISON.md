# Security comparison: OASIS, Claude Code, Codex CLI, Gemini CLI

Checked on 2026-11-02 against public documentation. The other tools change often, so treat their columns as a snapshot and check the linked docs before relying on them. "Yes" for OASIS means the feature is in `main` and has regression tests; it does not mean it has been independently audited.

Sources:
- Claude Code: [security](https://code.claude.com/docs/en/security), [permission modes](https://code.claude.com/docs/en/permission-modes), [security guidance plugin](https://code.claude.com/docs/en/security-guidance)
- Codex CLI: [approvals and security](https://github.com/ThomasRizzo/codex-cli-docs-offline/blob/main/learn.chatgpt.com/docs/agent-approvals-security.md)
- Gemini CLI: [trusted folders](https://geminicli.com/docs/cli/trusted-folders/), [configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)

| Area | OASIS | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| Permission prompts / modes | Yes (default, plan, acceptEdits, bypass) | Yes | Yes (approval policies) | Yes (default, auto-edit, yolo) |
| OS sandbox | Opt-in (bubblewrap / Seatbelt) | Opt-in | On by default (workspace-write, no network) | Opt-in, automatic with `--yolo` |
| Windows sandbox | No | No native | Yes | Via containers |
| Workspace trust | Yes | Yes (trust dialog) | Yes | Yes (off by default) |
| Catastrophic-command refusal through nesting (`bash -c`, `eval`, `$(…)`, `ssh`, inline Python/Node, PowerShell `-EncodedCommand`) | Yes, model-free, in every mode | Command-injection detection and a model-based classifier in auto mode | Relies on sandbox | Relies on sandbox / prompts |
| Credential exfiltration hold (`curl -d @.env`, env dumps) | Yes, even in bypass mode | Network commands need approval | Network off in sandbox | Not documented |
| Prompt-injection guard on web / MCP results | Hidden-Unicode stripping, injection flagging, shell held for the rest of the turn | Server-side probe in auto mode | Not documented | Not documented |
| MCP tool poisoning and definition pinning | Yes (poisoned descriptions withheld, changed definitions need re-approval) | Not documented | Not documented | Not documented |
| Hidden Unicode removed from AGENTS.md / CLAUDE.md / rules | Yes | Not documented | Not documented | Not documented |
| Protected config files (`.vscode/tasks.json`, `.envrc`, git hooks, `.npmrc`, other agents' configs) | Yes, incl. shell writes | Protected paths for its own config | Sandbox limits writes | Not documented |
| Secret masking in model context | Yes (35+ token formats, placeholders unmasked only in tool args) | Credential masking | Not documented | Not documented |
| Per-edit security pattern check | Yes, built in (`OASIS_SECURITY_CHECK=0` to disable) | Plugin (security-guidance) | No | No |
| Crash-safe atomic file writes | Yes (edits, config, credentials, state) | Not documented | Not documented | Yes (recent) |
| Sandbox keeps package caches writable | Yes (`~/.npm`, pip, cargo, Go, Maven, Gradle…) | Configurable allow-list | Configurable writable roots | Container-based |
| Web UI Content-Security-Policy | Hash-based `script-src` (no inline scripts), `frame-ancestors 'none'`, `connect-src 'self'` | Not applicable (no local web UI) | Not applicable | Not applicable |
| Desktop app permission policy | Only audio for dictation, notifications, clipboard write; camera, USB, serial, HID and webviews blocked | Not documented | Not documented | Not applicable |
| MCP OAuth issuer check (RFC 9207) | Yes, with PKCE (S256) and state | Not documented | Not documented | Not documented |
| Proxy support that keeps TLS end to end | CONNECT tunnel, certificate verified against the real host; `fetch_url` tunnels only to the vetted IP | Yes | Yes | Yes |

## Where OASIS is behind

- **Sandbox default.** Codex runs commands in a sandbox by default. OASIS's sandbox is opt-in. Package caches (`~/.npm`, `~/.cargo` and others) are now writable inside it, which removed the main reason builds broke, and `oasis doctor` suggests `/sandbox on` when it is available. Whether to make it the default is a product decision for the maintainer.
- **Windows sandbox.** OASIS has no native Windows sandbox. PowerShell and `cmd /c` commands go through the same model-free risk analysis.
- **Independent evidence.** The comparison above is based on documentation, not on a live red-team run against every tool.
