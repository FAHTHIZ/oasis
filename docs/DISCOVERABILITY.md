# OASIS GitHub profile and discoverability

This document is the source of truth for OASIS's public GitHub profile metadata. Keep the GitHub About panel, README, package metadata, and any future landing page consistent.

## GitHub About description

Paste this into **Repository → About → Description**:

> Open-source AI coding agent and local-first developer workspace with a CLI, browser UI, multi-provider LLMs, MCP integrations, skills, hooks, memory, and subagents.

This is intentionally product-specific: it says what OASIS is, identifies the CLI and browser workspace, and names the integration surface without making performance or maturity claims.

## GitHub Topics

The screenshot-style blue chips under the repository's About section are **GitHub Topics**. Add these 20 relevant topics in **Repository → About → Topics**:

```text
ai-coding-agent coding-agent ai-agents developer-tools developer-workspace cli terminal-agent llm mcp model-context-protocol agent-skills agentic-workflows local-first open-source javascript nodejs automation subagents ollama multi-provider
```

Keep the tags focused on capabilities that exist today. OASIS supports agent skills, MCP, multiple providers, local-provider options including Ollama, a CLI, automation workflows, and bounded subagents. It is not a Claude Code plugin, so do not copy Claude-specific tags from other repositories.

## Homepage field and GitHub Pages

**Do not set the GitHub About homepage to a guessed URL.** The current Pages workflow only deploys when the repository variable `OASIS_ENABLE_PAGES` is set to `true`, and the root `index.html` is the browser workspace rather than a dedicated public marketing page. Before filling in Homepage:

1. Decide what public page should be hosted and make sure it is safe and intended to be public.
2. Configure and verify deployment.
3. Set the About homepage to the verified live URL.
4. Add that same canonical URL to the README and site metadata.

Leave the homepage blank until that is done. Do not publish the workspace dashboard as a landing page by accident.

## Search-facing identity

- **Repository:** [FAHTHIZ/oasis](https://github.com/FAHTHIZ/oasis)
- **Product name:** OASIS
- **Short tagline:** Code. Automate. Flourish.
- **Descriptive phrase:** Open-source AI coding agent and local-first developer workspace
- **License:** MIT
- **Install command:**

  ```bash
  npm install -g git+https://github.com/FAHTHIZ/oasis.git#main
  ```

Use the descriptive phrase in the README and any future landing page. Keep the tagline as brand voice rather than relying on it to explain the product by itself.

## README badges and proof

Keep the badges at the top factual and maintainable:

- Quality-check badge: reflects the actual GitHub Actions workflow.
- MIT license badge: reflects `LICENSE`.
- Node.js badge: reflects the documented Node.js 22+ runtime requirement.

Only add npm version or release badges after a package is published or a GitHub release exists. Do not add fabricated trending awards, performance percentages, benchmark results, usage counts, or compatibility claims. Add a real screenshot or short demo when one is available.

## What helps discovery—and what does not

- A clear description and relevant topics help people classify and find the project on GitHub.
- A focused README, working installation instructions, visible capabilities and limitations, licensing, and repeatable quality checks help a visitor decide whether to try it.
- A real demo, tagged releases and an easy upgrade path give visitors evidence that they can evaluate.
- Search engines decide when to crawl pages and what snippets to display. Metadata and topics are useful foundations, not a promise of ranking, traffic, stars, or instant indexing.
- Avoid keyword stuffing, fake badges, unverified download counts, and unsupported maturity claims.

## Profile setup checklist

- [ ] Replace the default repository About description with the exact description above.
- [ ] Add the 20 topics above in the About panel.
- [ ] Add a verified homepage URL only after a dedicated public landing page is deployed.
- [ ] Publish a versioned release with tested installation instructions when the release is ready.
- [ ] Add a genuine product screenshot or short demo to the README when one is available.
- [ ] After the landing page is live, use Google Search Console to request indexing and monitor coverage.

## Reference examples

Well-established coding-agent repositories use a compact description that immediately says what the tool is, and a focused set of relevant topics. See [Ponytail](https://github.com/DietrichGebert/ponytail) for the repository-header pattern from your screenshot, plus [OpenCode](https://github.com/anomalyco/opencode) and [Cline](https://github.com/cline/cline) for concise product descriptions. OASIS should follow the same clarity-first pattern without copying another project's identity or claiming awards or benchmark results it has not earned.

*Metadata note: changing files in this repository does not automatically change GitHub's separate About description, topics, or homepage. Those must be changed in the repository settings.*
