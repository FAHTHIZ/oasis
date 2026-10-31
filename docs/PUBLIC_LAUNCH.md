# OASIS public launch and discoverability

This is the canonical guide for the static homepage, GitHub repository metadata and search-facing identity. It describes setup and automation, not a promise of search ranking or traffic.

## Homepage and deployment

The static public landing page is in `site/`. The root `index.html` is the actual local browser workspace and must remain separate. The `.github/workflows/pages.yml` workflow:

1. Validates the application, evaluation fixtures and public site.
2. Enables GitHub Pages when required.
3. Deploys only the `site/` directory.
4. Uses the actual deployment URL as the repository homepage.
5. Applies and verifies the repository About description and topic list.

Pull-request runs validate only; they do not receive the repository administration secret.

## One-time authorization

GitHub protects repository description, homepage and topic updates behind administration permissions. The workflow uses one Actions secret, `OASIS_REPO_ADMIN_TOKEN`. Create a fine-grained personal access token scoped only to `FAHTHIZ/oasis` with:

- **Administration: Read and write** — update About description, homepage and topics.
- **Pages: Read and write** — enable and publish GitHub Pages.

Add the token at [OASIS repository Actions secrets](https://github.com/FAHTHIZ/oasis/settings/secrets/actions) as `OASIS_REPO_ADMIN_TOKEN`. Then run [Publish OASIS homepage and repository metadata](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml) on the `main` branch. The workflow skips deployment and repository metadata updates when the secret is absent and writes that outcome to its summary. Never commit the token or paste it into issues or chat.

## Repository About identity

**Product name:** OASIS  
**Tagline:** Code. Automate. Flourish.  
**Description:** Open-source, local-first AI coding agent and developer workspace with CLI, browser workspace, desktop packaging, multi-provider models, MCP, skills, hooks and agent workflows.  
**License:** Apache-2.0

**Topics:**

```text
ai-coding-agent coding-agent ai-agents developer-tools developer-workspace cli terminal-agent llm mcp model-context-protocol agent-skills agentic-workflows local-first open-source javascript nodejs automation subagents ollama multi-provider
```

The description and tags should reflect OASIS itself, not external products or unmeasured claims. Keep the quality and license badges factual; add release/download/benchmark badges only when a genuine release or result exists.

## Search-facing content

The static homepage includes a descriptive title, search snippet, canonical URL, Open Graph metadata, `robots.txt` and an XML sitemap. These foundations make the site easier to classify, but crawlers determine when to index pages and what snippets to display. Metadata is not a ranking promise.

After deployment, Google Search Console can be used to monitor indexing and request a crawl. A request is not a guarantee of indexing or ranking.

For logo usage, colors, interface palette and alternative taglines, see [Brand](BRAND.md). For the actual product description and supported capabilities, use the [README](../README.md) and [project plan](PROJECT_PLAN.md).
