# Oasis OSS architecture

Oasis has a local-first browser workspace and a separate terminal agent runtime.

## Terminal runtime

- \`src/cli.mjs\` is the command-line entry point exposed by the \`oasis\` executable in \`package.json\`.
- \`src/config.mjs\` loads environment overrides or user-level config. Provider keys are never placed in project files by the CLI.
- src/agent.mjs implements multi-step tool-calling loops for the OpenAI Responses API, OpenAI-compatible Chat Completions, and native Anthropic Messages. Responses API output items are replayed locally with `store: false` so tool-call continuation does not depend on server-side conversation storage.
- src/tools.mjs exposes file listing, glob matching, literal search, line-ranged reads, exact-string edit_file patches with snapshots, whole-file writes, approved deletes, argv-only process execution, package installation, skill discovery/loading, and bounded public-document fetching.
- \`src/installer.mjs\` parses simple installation requests and selects a package ecosystem or host package manager.
- \`src/backups.mjs\` snapshots changed files to the user's Oasis config directory, outside the project, and restores them by ID.
- src/eval.mjs runs reference tasks in disposable copies, captures token/time/cost estimates, and stores JSON results. evals/tasks/<id>/ keeps the task prompt, pre-change snapshot, patch, and verifier outside the agent's workspace.
- skills/*/SKILL.md contains bundled workflow guidance. The agent initially receives compact skill descriptions and loads the full relevant guide only on demand. Workspace skills live under .oasis/skills/<name>/SKILL.md.
- Project context can come from \`OASIS.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and \`.oasis/skills\`.

### Data and trust boundaries

Workspace file tools apply path traversal and symlink checks, block common credential-file patterns, and cap individual text-file sizes. A snapshot is created before overwriting an existing file. Deletion needs interactive approval. Shell interpreters and selected high-impact commands are denied by the general command tool; normal commands require approval unless automatic approval is deliberately enabled.

Processes launch with an argument array and \`shell: false\`; common credential environment variables are filtered. The package installer is a separate, explicit side-effecting tool and its command plan is shown before approval. Public URL fetching checks host resolution for private addresses, rejects redirects, and limits content size.

This is not an OS sandbox. An approved test, build, or project script can execute code with the current user's privileges. A local model endpoint may avoid sending prompts to a hosted provider, but that does not itself sandbox command execution.

## Model provider interface

The runtime supports the native OpenAI Responses API (`/responses` appended to the configured base URL), OpenAI-compatible Chat Completions (`/chat/completions`), and the native Anthropic Messages API (`/v1/messages`). GPT-6.1 Sol tool calling uses the Responses API. Set OASIS_BASE_URL, OASIS_MODEL, and OASIS_API_KEY, or use oasis setup. Loopback endpoints can use HTTP and do not require an API key. Non-local endpoints must use HTTPS.

## Browser workspace

The root \`index.html\` provides a dependency-free dashboard for projects, tasks, and notes. The browser stores workspace data in local storage and exports/imports JSON backups. The PWA manifest, SVG icon, and service worker support an installable app shell and static offline cache on compatible HTTPS hosts. Browser data is not encrypted and does not sync between devices.

## Quality gates

- \`scripts/check-site.mjs\`: validates interface anchors, inline JavaScript syntax, and PWA assets.
- \`test/runtime.test.mjs\`: exercises configuration, install parsing, path protections, snapshots, approvals, environment filtering, private URL rejection, and a mock local model/tool loop.
- test/eval.test.mjs covers task validation and a model run against a local OpenAI-compatible fixture server.
- \`.github/workflows/quality.yml\`: runs the checks and package dry-run for pushes and pull requests.
- The quality gate also runs oasis eval --validate to ensure each reference patch turns a failing no-op verifier into a passing verification.
- \`.github/workflows/pages.yml\`: checks the repository and deploys the static site when GitHub Pages is configured.

## Current architectural gaps

OS-level container isolation, model-written context summaries, streamed model output, multi-agent coordination, formal version migrations, cross-device sync, and live sharing between the browser dashboard and CLI are not part of this implementation yet. The evaluation suite is an experimental smoke benchmark rather than a broad full-project benchmark.
