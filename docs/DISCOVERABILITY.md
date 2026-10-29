# OASIS GitHub profile and discoverability

OASIS's public identity is managed in the README, `package.json`, the landing page in `site/`, and the launch workflow. Keep these sources consistent.

## GitHub About description

The launch workflow applies this description to the repository settings after deployment succeeds:

> Open-source AI coding agent and local-first developer workspace with a CLI, browser UI, multi-provider LLMs, MCP integrations, skills, hooks, memory, and subagents.

## GitHub Topics

The launch workflow applies these 20 relevant topics as the blue clickable chips under the repository's About section:

```text
ai-coding-agent coding-agent ai-agents developer-tools developer-workspace cli terminal-agent llm mcp model-context-protocol agent-skills agentic-workflows local-first open-source javascript nodejs automation subagents ollama multi-provider
```

The tags reflect current features: an agent CLI, browser workspace, multiple model providers, MCP, Agent Skills, automation, and bounded subagents. OASIS is an independent coding agent, not an external-tools plugin; use only tags that accurately describe OASIS itself.

## Homepage and metadata automation

The dedicated static landing page lives in `site/` so the root `index.html` remains the browser workspace. The `.github/workflows/pages.yml` workflow validates and deploys only `site/`, then applies the GitHub repository description, deployed homepage URL, and topic list.

One-time setup is documented in [PUBLIC_LAUNCH.md](PUBLIC_LAUNCH.md): create the `OASIS_REPO_ADMIN_TOKEN` Actions secret using a fine-grained token scoped to this repository with Administration: write and Pages: write. Never store credentials in source. PRs run validation only and do not receive this secret.

## Search-facing identity

- **Repository:** [FAHTHIZ/oasis](https://github.com/FAHTHIZ/oasis)
- **Product name:** OASIS
- **Tagline:** Code. Automate. Flourish.
- **Product description:** Open-source AI coding agent and local-first developer workspace
- **Project license:** Apache-2.0
- **Install command:** `npm install -g git+https://github.com/FAHTHIZ/oasis.git#main`

## README badges

Keep the top-of-README proof factual and maintainable:

- Quality-check badge: reflects the actual GitHub Actions workflow.
- Apache-2.0 license badge: reflects `LICENSE`.
- Node.js badge: reflects the documented Node.js 22+ runtime requirement.
- Homepage badge: links to the landing page deployed by the launch workflow.

Add npm version, release/download or benchmark badges only when there is a real published package/release or verified result. Do not add fabricated trending awards, performance numbers, download counts, or popularity claims.

## What helps discovery—and what does not

A clear repository description and relevant topics improve classification and make the project easier to understand in GitHub search. A focused README, working installation instructions, visible capability limits, licensing, quality checks, and a genuine landing page help visitors evaluate it. Search engines determine when to crawl pages and what snippets to display; metadata is useful setup, not a promise of ranking or instant traffic.

After the site is live, Google Search Console can help monitor indexing and request a crawl. An index request is not a guarantee of ranking.

## Reference examples

Established coding-agent repositories commonly use a concise description that identifies the product and a focused set of relevant topics. See [Ponytail](https://github.com/DietrichGebert/ponytail), [OpenCode](https://github.com/anomalyco/opencode), and [Cline](https://github.com/cline/cline) for examples of clear positioning. OASIS should follow the same clarity-first pattern without copying another project's identity or claiming awards or benchmarks it has not earned.
