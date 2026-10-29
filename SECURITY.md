# Security policy

## Current security boundary

See [Security and reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md) for recent fixes, verification status and open security boundaries. This is a source-level pass, not a guarantee that every defect has been found.

Oasis OSS has two parts:

- The browser workspace is a static client-side app. Projects, tasks, and notes are stored in browser local storage and are not encrypted by the application.
- The terminal coding agent runs with the current OS user's permissions. It uses a remote or local model provider and launches local tools/commands as requested.

Do not store passwords, API keys, private keys, payment information, or sensitive personal data in browser notes. Browser exports are plain JSON. The CLI's provider key is stored in the user's configuration directory with mode 0600 where supported; environment variables can be used instead.

## Agent safeguards and their limits

The CLI confines file tools to the selected workspace, blocks common secret-file paths, snapshots files before overwriting, requires interactive approval for file deletion, asks before command execution and package installation by default, blocks several destructive commands, strips common credential variables from child-process environments, restricts URL fetching to public HTTP/HTTPS targets, and supports user-configured MCP stdio servers with per-tool approval. MCP servers are arbitrary executables and can execute with the current user's permissions.

The web command runner reuses the CLI's executable-plus-argv policy and does not permit arbitrary shell expansion through that interface. The browser workspace now has a PTY-backed terminal path with a bundled xterm.js renderer when the optional native PTY dependency is available; cross-platform process cleanup and the full browser-terminal lifecycle are not yet completely validated. GitHub access reuses a host-side `gh auth login` session: the browser never receives the GitHub CLI token. Fixed API calls list accessible repositories, and a selected repository clone requires an approval before any files are downloaded. Cloned project code is still untrusted and must not be executed without reviewing the requested command.

The runtime bridge supports HTTPS when both a certificate and private-key file are supplied with `--tls-cert` and `--tls-key`; it enforces TLS 1.2 or newer and refuses a non-loopback listener without TLS unless `--allow-insecure-lan` is explicitly set. That option deliberately permits unencrypted LAN traffic. Do not use it on public or untrusted networks, and never port-forward or publish the runtime to the Internet. Certificate provisioning/renewal, reverse-proxy deployment instructions and real-device trust tests are not yet a turnkey managed service. TLS protects the transport but does not replace token secrecy, trusted-device controls, workspace isolation or careful network binding.

Plugin archive downloads via `--plugin-url` are limited to HTTP(S), require HTTPS for non-loopback hosts, reject credentials in URLs and private/special-purpose address ranges, pin resolved DNS answers for the request, and revalidate each redirect. Downloads are time/size bounded. ZIP extraction rejects traversal and ambiguous paths, duplicate/case-colliding names, symlink writes, oversized expanded content, and malformed central/local headers; temporary plugin archives are intended to be removed when the CLI process exits. These checks reduce SSRF and archive-path risks, but they do not make third-party plugin code trustworthy. Only load plugins from sources you trust.

Command, path, URL and approval checks are defense in depth, not a substitute for OS isolation. When the optional OS sandbox is enabled and available on Linux or macOS, it restricts writes to configured workspace paths, blocks network access by default, and masks detected common credential paths (including SSH, cloud CLI, Git, and OASIS credential locations). This reduces exposure but is not full filesystem-read isolation: other files may remain readable, and Windows currently falls back to approval checks. Package installation can execute third-party code. The `--yes` option automatically approves supported ordinary command/install operations and should not be used with untrusted repositories. No system can promise that an arbitrary model, repository, MCP server, or package is safe.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Contact the repository owner privately through GitHub's available private reporting/contact options and include the affected version, reproduction steps, expected behavior, and potential impact. Do not include real secrets or another person's private data in a report.

## Supported versions

Only the latest version on the default branch is currently maintained. A formal release policy will be added when versioned releases exist.
