# Oasis OSS architecture

Oasis has a local-first browser workspace and a CLI agent runtime. Running `oasis web` serves the same browser UI from Node and connects it to the chosen workspace through an authenticated local HTTP API.

## Terminal runtime

- \`src/cli.mjs\` is the command-line entry point exposed by the \`oasis\` executable in \`package.json\`.
- \`src/config.mjs\` loads environment overrides or user-level config. Provider keys are never placed in project files by the CLI.
- src/agent.mjs implements multi-step tool-calling loops for the OpenAI Responses API, OpenAI-compatible Chat Completions, and native Anthropic Messages. Responses API output items are replayed locally with `store: false` so tool-call continuation does not depend on server-side conversation storage. Long histories are compacted between turns using a tool-free model summary, with a deterministic bounded fallback if summarization fails.
- When the browser runtime requests live output, `src/agent.mjs` requests provider SSE streams and normalizes text/tool-call deltas across Chat Completions, Responses, and Anthropic Messages. Stream payloads are capped at 8 MiB; providers that respond with ordinary JSON fall back to a completed-text event rather than failing the task.
- Browser jobs own an abort controller. The authenticated cancel route denies pending approvals, aborts model requests, and forwards cancellation to supported child-process commands and package installs; jobs end in an explicit `cancelled` state and the current session is saved when possible. Cancellation cannot roll back file changes that completed before the request.
- The `run_specialist_review` tool creates a separate, bounded reviewer session for code review, security review, architecture, or test strategy. It receives only file-search/read and Git-inspection tools, has no MCP client, cannot run commands or edit, caps itself at eight read-only tool calls and 18,000 tokens, and is limited to two reviews per parent task. Nested token/tool use is included in the parent usage totals.
- src/tools.mjs exposes read-only Git status/diff inspection, file listing, glob matching, literal search, line-ranged reads, exact-string edit_file patches with snapshots, whole-file writes, approved deletes, argv-only process execution, package installation, skill discovery/loading, and bounded public-document fetching. Whole-worktree diffs exclude common secret-bearing paths; explicitly scoped paths pass through workspace/sensitive-path checks.
- \`src/installer.mjs\` parses simple installation requests and selects a package ecosystem or host package manager.
- \`src/backups.mjs\` snapshots changed files to the user's Oasis config directory, outside the project, and restores them by ID.
- src/eval.mjs runs reference tasks in disposable copies, captures token/time/cost estimates, and stores JSON results. evals/tasks/<id>/ keeps the task prompt, pre-change snapshot, patch, and verifier outside the agent's workspace.
- skills/*/SKILL.md contains bundled workflow guidance. `plugins/catalog.json` defines reviewed skill bundles; `src/plugins.mjs` installs/removes these bundles under `.oasis/plugins/` and `.oasis/skills/`. Bundles currently contain instruction files only; MCP server configuration is separate and explicit. The agent initially receives compact skill descriptions and loads the full relevant guide only on demand. Workspace skills live under .oasis/skills/<name>/SKILL.md.
- Project context can come from \`OASIS.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and \`.oasis/skills\`.

### Data and trust boundaries

Workspace file tools apply path traversal and symlink checks, block common credential-file patterns, and cap individual text-file sizes. A snapshot is created before overwriting an existing file. Deletion needs interactive approval. Shell interpreters and selected high-impact commands are denied by the general command tool; normal commands require approval unless automatic approval is deliberately enabled.

Processes launch with an argument array and \`shell: false\`; common credential environment variables are filtered. The package installer is a separate, explicit side-effecting tool and its command plan is shown before approval. Public URL fetching checks host resolution for private addresses, rejects redirects, and limits content size.

This is not an OS sandbox. An approved test, build, or project script can execute code with the current user's privileges. A local model endpoint may avoid sending prompts to a hosted provider, but that does not itself sandbox command execution.

## Browser agent runtime

- `src/web.mjs` serves the static UI and a same-origin JSON API. The listener binds to `127.0.0.1:3917` by default; the CLI prints a fresh random bearer token for that process. API requests require that token, and browser API requests must use a literal-IP/localhost Host and a matching same-origin HTTP Origin.
- Chat jobs call the same `createSession` and `runAgentTurn` runtime used by the CLI. Job events expose assistant output, tool activity, usage, completion, and pending approvals. The browser can approve or deny a consequential action once. Saved agent sessions use the existing private user-level session store.
- The Terminal panel calls the existing `run_command` tool with an executable and a JSON argv array. It intentionally has no shell expansion and is **not a full PTY**; interactive shell programs, TUI applications, and programs that require stdin are not supported by this bridge.
- Localhost is the safe default. Binding to `0.0.0.0` makes the HTTP server reachable from the network; the token is not encrypted in transit. Use only on trusted private Wi-Fi, do not port-forward it, and never expose the listener to the public Internet. TLS/reverse-proxy deployment is not implemented.
- The service worker must not cache `/api/*` responses because Cache Storage does not isolate entries by bearer Authorization header. It caches only the static app shell.

## GitHub connection and workspace switching

- The browser UI reuses the host's GitHub CLI login instead of collecting a personal token in the page. The runtime exposes fixed read-only commands for `gh auth status` and `gh api user/repos`; it does not accept arbitrary GitHub CLI arguments from the browser.
- The repository picker lists at most 30 repositories from the authenticated user's accessible `user/repos` endpoint. Cloning validates `owner/name`, resolves a destination beneath the launch workspace's `.oasis/workspaces/` directory with workspace path checks, requires an explicit approval, then uses `gh repo clone` with shell expansion disabled. It never runs the repository's install scripts as part of cloning.
- A successful clone switches the process's active workspace for new agent sessions and terminal commands. A request cannot switch workspaces while any tracked job or agent turn is running. Existing clone destinations are reused only after their origin matches the selected GitHub repository.
- This is a GitHub CLI integration, not embedded OAuth. The user must install `gh` and run `gh auth login` on the host first. Repository creation, branch/push/PR orchestration, GitHub Apps, detailed scope management, and organization-wide repository discovery are not implemented.

## External GitHub agent/skill imports

- `src/extensions.mjs` inspects public GitHub repository metadata, resolves a default-branch commit SHA, and selects bounded Markdown agent/skill prompt files. The review endpoint returns repository, license, commit, importable-file count, and a count of executable/source files detected.
- Import requires a second request carrying the commit SHA shown by inspection; a changed default-branch commit is rejected rather than importing a revision the user did not review.
- Oasis only writes normalized Markdown prompts plus an extension manifest. It does not import or execute repository scripts, copy executables, install dependencies, enable hooks, or configure MCP servers. Each prompt carries source/commit attribution and an untrusted-instructions notice.
- Global extensions live under the user-level Oasis config `extensions/`; project extensions live under `.oasis/extensions/`. The `self`, `project`, and `both` scopes support reuse between projects. A staging directory and atomic rename are used for installs, and an incomplete multi-scope install is rolled back.
- Every imported prompt has a SHA-256 record. Removal verifies that the extension has no unexpected files and that prompt contents still match their installation hashes; modified content is preserved rather than deleted. Installed extensions are exposed to normal skill discovery so imported guidance can be loaded on demand.
- Browser routes for inspect/install/remove and inventory are protected by the same bearer-token API authentication. Importing an instruction file does not constitute sandboxing; agent prompts remain untrusted context and never override the base system policy.

## Integration hub

The browser provides tabs for Connectors, MCP servers, API & models, and Tools. GitHub status is sourced from the host GitHub CLI, provider status from the local runtime, and MCP configuration from the user configuration file. Unsupported connector cards and custom tool/webhook authoring are explicitly labelled as planned rather than reporting fictitious connections. Saving an enabled MCP server updates future session configuration; it does not launch the process during save, but creating a new agent session starts configured enabled servers.

## Model provider interface

The runtime supports the native OpenAI Responses API (`/responses` appended to the configured base URL), OpenAI-compatible Chat Completions (`/chat/completions`), and the native Anthropic Messages API (`/v1/messages`). GPT-6.1 Sol tool calling uses the Responses API. Set OASIS_BASE_URL, OASIS_MODEL, and OASIS_API_KEY, or use oasis setup. Loopback endpoints can use HTTP and do not require an API key. Non-local endpoints must use HTTPS.

## Browser workspace

The root \`index.html\` provides a dependency-free dashboard for projects, tasks, and notes. The browser stores workspace data in local storage and exports/imports JSON backups. The PWA manifest, SVG icon, and service worker support an installable app shell and static offline cache on compatible HTTPS hosts. Browser data is not encrypted and does not sync between devices.

## Quality gates

- \`scripts/check-site.mjs\`: validates interface anchors, inline JavaScript syntax, and PWA assets.
- \`test/runtime.test.mjs\`: exercises configuration, install parsing, path protections, snapshots, approvals, environment filtering, private URL rejection, and a mock local model/tool loop.
- test/eval.test.mjs covers task validation and a model run against a local OpenAI-compatible fixture server.
- \`.github/workflows/quality.yml\`: runs the checks and package dry-run for pushes and pull requests.
- The agent also has a read-only plan mode (`oasis plan` or `/plan`) with a separate tool allowlist and an executor-side check against write/command/install/delete/MCP calls. The quality gate runs `oasis eval --validate` to ensure each reference patch turns a failing no-op verifier into a passing verification.
- \`.github/workflows/pages.yml\`: checks the repository and deploys the static site when GitHub Pages is configured.

## Current architectural gaps

OS-level container isolation, a full interactive PTY, TLS for the browser runtime, GitHub OAuth, a remote capability marketplace, streamed token output, mid-turn context compaction, multi-agent coordination, formal version migrations, and browser-to-CLI syncing for projects/tasks/notes are not implemented yet. Between-turn context compaction is best-effort and is not a substitute for a broad long-horizon benchmark. The evaluation suite is an experimental smoke benchmark rather than a broad full-project benchmark.


## Cross-ecosystem extension compatibility

Oasis's extension inspector detects portable Agent Skills layouts and Claude Code, Codex, and Gemini CLI markers from a public GitHub tree. The report separates Markdown prompts the current runtime can load from commands, MCP declarations, hooks, executable files, and plugin-specific behavior that is only detected. Finding a manifest does not mean the full extension is operational. Imported prompt content remains untrusted, commit-pinned and integrity-tracked. Future adapters must convert each ecosystem into an explicit install plan, validate paths and dependency boundaries, and gate tool servers and lifecycle code through review, permissions, audit logs and rollback.
