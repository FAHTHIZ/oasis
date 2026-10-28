# OASIS GitHub profile and discoverability

This document is the source of truth for OASIS's public GitHub profile metadata. Keep the GitHub About panel, README, package metadata, and any future landing page consistent.

## GitHub About description

Paste this into **Repository → About → Description**:

> Open-source AI coding agent and local-first developer workspace with a CLI, browser UI, multi-provider LLMs, MCP integrations, skills, hooks, memory, and subagents.

This is intentionally product-specific: it says what OASIS is, identifies the CLI and browser workspace, and names the integration surface without making performance or maturity claims.

## GitHub topics

Add the following topics to **Repository → About → Topics**. They are limited to features that the project currently describes or supports; do not add unrelated or aspirational topics just to chase search traffic.

```text
ai-coding-agent coding-agent ai-agent coding-assistant developer-tools developer-workspace cli terminal-agent llm multi-provider mcp model-context-protocol agentic-workflows local-first open-source javascript nodejs automation subagents ollama
```

GitHub allows up to 20 topics per repository. The list above uses 20. If the project changes, remove topics that are no longer accurate before adding new ones.

## Search-facing identity

- **Repository name:** `FAHTHIZ/oasis`
- **Product name:** OASIS
- **Short tagline:** Code. Automate. Flourish.
- **Descriptive phrase:** Open-source AI coding agent and local-first developer workspace
- **License:** MIT
- **Install command:**

  ```bash
  npm install -g git+https://github.com/FAHTHIZ/oasis.git#main
  ```

Use the descriptive phrase in the README and future landing page. Keep the tagline as brand voice rather than relying on it to explain the product on its own.

## Homepage field and GitHub Pages

**Do not set the GitHub About homepage to a guessed URL.** The current Pages workflow only deploys when the repository variable `OASIS_ENABLE_PAGES` is set to `true`, and the root `index.html` is the browser workspace rather than a dedicated public marketing page. Before filling in Homepage:

1. Decide what public page should be hosted and make sure it is safe and intended to be public.
2. Configure and verify deployment.
3. Set the About homepage to the verified live URL.
4. Add that same canonical URL to the README and site metadata.

Leave the homepage blank until that is done. Do not publish the workspace dashboard as a landing page by accident.

## What helps discovery—and what does not

- A clear description and relevant topics help people classify and find the project on GitHub.
- A focused README, working installation instructions, visible capabilities and limitations, licensing, and a repeatable quality check help a visitor decide whether to try it.
- A real demo, screenshots, tagged releases and an easy upgrade path give visitors evidence that they can evaluate.
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

Well-established coding-agent repositories use a compact description that immediately says what the tool is, and a small, relevant set of topics. For example, the [OpenCode repository](https://github.com/anomalyco/opencode) describes itself as an open-source coding agent, while [Cline](https://github.com/cline/cline) describes its agent across SDK, IDE extension, and CLI. OASIS should follow the same clarity-first pattern without copying another project's identity.

*Metadata note: updating files in this repository does not automatically update GitHub's separate About description, topics, or homepage settings. Those must be changed in the repository's About panel.*
