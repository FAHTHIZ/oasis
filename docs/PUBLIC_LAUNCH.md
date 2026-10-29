# OASIS public launch setup

The public landing page and repository metadata automation live in this repository. The landing page is separate from the root `index.html`, which remains the local browser workspace used by `oasis web`.

## What the launch workflow does

On pushes to `main` and when manually run on `main`, `.github/workflows/pages.yml`:

1. Runs the existing app/runtime/evaluation checks plus the public-site checks.
2. Enables GitHub Pages for the repository if necessary.
3. Deploys the `site/` directory as the public homepage.
4. Uses the verified deployment URL as the repository homepage.
5. Applies and verifies the GitHub About description and 20 topics.

Pull requests run validation only. They never receive the repository metadata credential.

## One-time authorization required

GitHub protects repository description, homepage, and topic updates behind repository administration permissions. The normal Actions `GITHUB_TOKEN` cannot perform this settings update. The Pages action also requires a separate token to enable Pages on a repository that has not been enabled yet. The workflow reads one Actions secret; it never asks for a token in source code or logs.

Create a **fine-grained personal access token** scoped only to `FAHTHIZ/oasis` with these repository permissions:

- **Administration: Read and write** — required for the About description, homepage, and topics.
- **Pages: Read and write** — required to enable and publish GitHub Pages.

Keep the token private. Do not commit it to this repository or paste it into issues or chat.

Then add it as a repository Actions secret:

1. Open [OASIS repository secrets](https://github.com/FAHTHIZ/oasis/settings/secrets/actions).
2. Choose **New repository secret**.
3. Set the name to `OASIS_REPO_ADMIN_TOKEN`.
4. Paste the token into the secret value and save it.

After the secret exists, open [Actions → Publish OASIS homepage and repository metadata](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml), select **Run workflow** on the `main` branch, and run it. A merge before the secret exists safely runs validation but skips the live deployment and settings update; the workflow summary will say so.

## Metadata applied after deployment succeeds

**Repository description**

> Open-source AI coding agent and local-first developer workspace with a CLI, browser UI, multi-provider LLMs, MCP integrations, skills, hooks, memory, and subagents.

**Topics**

```text
ai-coding-agent coding-agent ai-agents developer-tools developer-workspace cli terminal-agent llm mcp model-context-protocol agent-skills agentic-workflows local-first open-source javascript nodejs automation subagents ollama multi-provider
```

The homepage field is set to the actual URL returned by the deployment action, not a guessed value. If deployment fails, the metadata update does not run.

## Search visibility

The landing page includes a descriptive title, search snippet, canonical URL, Open Graph metadata, `robots.txt`, and an XML sitemap. These foundations help discovery but do not guarantee search rankings or instant traffic. Once the page is public, add it to Google Search Console to monitor indexing.

Keep repository badges factual: quality checks, Apache-2.0 license, and Node.js runtime. Add release/download/trending/benchmark badges only when there is a genuine release, verified data, or measured result to support them.
