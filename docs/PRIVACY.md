# OASIS privacy notes

OASIS runs on your computer. It is not a hosted AI service, and it does not supply the model account for you. Network traffic depends on which providers and integrations you choose to enable.

## Model providers

When you send a task to a hosted model provider, OASIS sends the conversation and the tool context needed for that request. That may include snippets of source files, filenames, terminal output, error messages, and instructions from the project. The provider processes that data under its own terms and retention settings. Do not send code or data that you are not allowed to share with that provider.

A local model endpoint can keep model requests on your machine, but only if the endpoint really is local and the model service does not forward the data elsewhere. Confirm the endpoint before using it.

## API keys

- The desktop provider form stores new API keys using Electron's OS-backed encryption when that facility is available. If it is not available, the desktop app should refuse to save the key through that form.
- The command-line configuration remains a separate storage path. It protects the config file with restrictive permissions where the operating system supports them, but this is not the same as encrypting the key.
- Never paste a real key into source files, bug reports, screenshots, model prompts or public issues.

## Search and integrations

OASIS may use configured search providers such as Tavily, Brave, Exa, Firecrawl or a self-hosted SearXNG endpoint. The keyless fallback scrapes DuckDuckGo when upstream access permits. Search queries are sent to whichever search service is used. MCP servers, hooks, skills that execute code, and third-party plugins may run with your user permissions; only enable integrations you trust.

## Local browser workspace

The browser dashboard stores some projects, tasks and notes in browser local storage. That content is not encrypted by OASIS. Do not save passwords, API keys, private keys or sensitive personal information in notes. The browser runtime bearer token is a secret: treat it like a password, keep it out of screenshots and logs, and do not expose the runtime to the public Internet.

## Remote access

The default runtime is loopback-only. Do not port-forward it or publish it to the Internet. Non-loopback listeners require TLS unless the operator deliberately opts into unencrypted LAN access. A future phone connection mode must remain opt-in, use pairing and revocable device tokens, and have a separate reviewed threat note before implementation.

OASIS is an alpha hobby project. These notes describe intended behavior and known boundaries, not a guarantee that every configuration is private or secure. Review [SECURITY.md](../SECURITY.md) before using it with sensitive work.
