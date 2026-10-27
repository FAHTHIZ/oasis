# Security policy

## Current security boundary

Oasis OSS is a static, client-side application. It has no account system, backend API, or server-side authorization. Workspace data is stored in browser local storage and is not encrypted by this application.

Do not store passwords, tokens, private keys, payment information, or sensitive personal data in Oasis. A person with access to the browser profile or an exported backup may be able to read the workspace.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Contact the repository owner privately through GitHub's available private reporting/contact options and include the affected version, steps to reproduce, expected behavior, and potential impact. Do not include real secrets or another person's private data in a report.

## Supported versions

Only the latest version on the default branch is currently maintained. A formal release policy will be added when versioned releases exist.
