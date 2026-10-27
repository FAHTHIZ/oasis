# Oasis OSS architecture

Oasis has a local-first browser workspace and a separate terminal agent runtime.

## Terminal runtime

- \`src/cli.mjs\` is the command-line entry point exposed by the \`oasis\` executable in \`package.json\`.
- \`src/config.mjs\` loads environment overrides or user-level config. Provider keys are never placed in project files by the CLI.
- \`src/agent.mjs\` implements a multi-step tool-calling loop against an OpenAI-compatible chat-completions API. It retains the current process's conversation and uses tool-call results as the next model input.
- \`src/tools.mjs\` exposes file listing/search/read/write/delete, argv-only process execution, package installation, and bounded public-document fetching.
- \`src/installer.mjs\` parses simple installation requests and selects a package ecosystem or host package manager.
- \`src/backups.mjs\` snapshots changed files to the user's Oasis config directory, outside the project, and restores them by ID.
- \`skills/*/SKILL.md\` contains bundled workflow guidance. Users can install a skill to \`.oasis/skills/<name>/SKILL.md\`; those files are loaded as project context in later sessions.
- Project context can come from \`OASIS.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and \`.oasis/skills\`.

### Data and trust boundaries

Workspace file tools apply path traversal and symlink checks, block common credential-file patterns, and cap individual text-file sizes. A snapshot is created before overwriting an existing file. Deletion needs interactive approval. Shell interpreters and selected high-impact commands are denied by the general command tool; normal commands require approval unless automatic approval is deliberately enabled.

Processes launch with an argument array and \`shell: false\`; common credential environment variables are filtered. The package installer is a separate, explicit side-effecting tool and its command plan is shown before approval. Public URL fetching checks host resolution for private addresses, rejects redirects, and limits content size.

This is not an OS sandbox. An approved test, build, or project script can execute code with the current user's privileges. A local model endpoint may avoid sending prompts to a hosted provider, but that does not itself sandbox command execution.

## Model provider interface

The runtime expects an OpenAI-compatible \`/chat/completions\` endpoint with tool-calling support. Set \`OASIS_BASE_URL\`, \`OASIS_MODEL\`, and \`OASIS_API_KEY\`, or use \`oasis setup\`. Loopback endpoints can use HTTP and do not require an API key. Non-local endpoints must use HTTPS. 

## Browser workspace

The root \`index.html\` provides a dependency-free dashboard for projects, tasks, and notes. The browser stores workspace data in local storage and exports/imports JSON backups. The PWA manifest, SVG icon, and service worker support an installable app shell and static offline cache on compatible HTTPS hosts. Browser data is not encrypted and does not sync between devices.

## Quality gates

- \`scripts/check-site.mjs\`: validates interface anchors, inline JavaScript syntax, and PWA assets.
- \`test/runtime.test.mjs\`: exercises configuration, install parsing, path protections, snapshots, approvals, environment filtering, private URL rejection, and a mock local model/tool loop.
- \`.github/workflows/quality.yml\`: runs the checks and package dry-run for pushes and pull requests.
- \`.github/workflows/pages.yml\`: checks the repository and deploys the static site when GitHub Pages is configured.

## Current architectural gaps

Container isolation, persistent sessions, streamed model output, parallel tool execution, multi-agent coordination, formal version migrations, cross-device sync, and live sharing between the browser dashboard and CLI are not part of this implementation yet.
