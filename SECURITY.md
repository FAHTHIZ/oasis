# Security policy

OASIS can read and modify project files, run commands and connect to model providers or external services. Treat it as software with access to the permissions of the process running it.

## Reporting a vulnerability

Please do not disclose vulnerabilities in public issues, discussions or pull requests.

Use [GitHub's private vulnerability reporting form](https://github.com/FAHTHIZ/oasis/security/advisories/new) to send a report privately. Include the affected version or commit, the impact, reproducible steps and any relevant sanitized logs. Do not attach credentials, private keys or private project data.

If private vulnerability reporting is unavailable, contact the repository maintainer privately through GitHub before publishing details. Please allow time for investigation and a coordinated fix; no response-time guarantee is made in this policy.

## Security boundaries

- Approval prompts do not provide OS-level isolation.
- Optional sandbox backends differ by platform and configuration. Verify that a sandbox is active before relying on it.
- MCP servers, hooks, plugins and imported extensions may execute third-party code.
- Hosted model and external service providers may receive project context and tool output.
- Keep credentials out of source control and review commands before approving them.
