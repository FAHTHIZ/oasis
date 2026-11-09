# OASIS user guide

OASIS is an open-source coding agent you run on a computer or server you control and use from any modern browser. The runtime owns the project, the shell and your model keys; the browser is only the screen. This guide walks through installing it, signing in, connecting a model, running a task and reviewing the result.

<p align="center"><img src="../assets/screenshots/web-task-dark.png" alt="OASIS web app after a finished task: the user's request, short progress updates, folded execution groups with a subagent, and the Files panel" width="860"></p>

## 1. Choose an interface

OASIS has two interfaces that share one runtime, one session store and one set of settings.

| If you want to… | Use | Start it with |
|---|---|---|
| Work in a browser, on this computer or from anywhere | **Web app** | `oasis web --open` |
| Work directly in a terminal | **Terminal session** | `oasis` |

Integrations (editor extension, Agent Client Protocol, Node.js SDK, GitHub Action, messaging gateways) connect OASIS to other tools; see [Interfaces and deployment](INTERFACES.md). There is no separate desktop or mobile app: a phone, tablet or laptop opens the same web app in its browser.

## 2. Install OASIS

Requirements: Node.js 22.15 or newer and Git.

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
oasis doctor
```

`oasis --help` lists every command. Release tarballs with `SHA256SUMS` are on [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest); see [Downloads and releases](RELEASES.md).

## 3. Connect a model provider

OASIS is a runtime, not an inference service. Bring a key or a local model server you are allowed to use. Paste it into the web app's connect box (or run `oasis connect` in a terminal): OASIS recognises the provider from the key or address, lists its models, picks a strong default and saves it on the computer running OASIS. Keys are stored there, never sent back to the browser, and never written into the project.

| Provider | Where to get a key | Notes |
|---|---|---|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | One key for hundreds of models. Free models are limited to 20 requests a minute and 50 a day (1,000 a day after buying $10 of credits), per [OpenRouter's limits](https://openrouter.ai/docs/api_reference/limits). |
| NVIDIA NIM | [build.nvidia.com](https://build.nvidia.com/) | Keys start with `nvapi-`. OpenAI-compatible endpoint `https://integrate.api.nvidia.com/v1`, with a free prototyping tier. |
| OmniRoute | [Self-hosted gateway](https://github.com/cheaper-inference/omniroute) | Runs on `http://localhost:20128/v1` and routes one endpoint to many providers. Paste the address. |
| Anthropic, OpenAI, Gemini, Groq, DeepSeek, xAI, Mistral, Hugging Face | The provider's console | Paste the key; the provider is detected from its prefix. |
| Ollama, LM Studio, llama.cpp | Your own machine | Started servers on their default ports are found automatically. |

Before entering a credential:

- Check that prompts and project context may be sent to that provider.
- Never commit keys, paste them into issues, or show them in screenshots.
- Provider setup over the network is accepted only over HTTPS, so keys are encrypted in transit.

See the [configuration reference](CONFIGURATION.md) for fallback models, task-aware routing and environment variables.

## 4. Terminal session

```sh
cd /path/to/your/project
oasis
```

`oasis` starts the interactive session. `oasis -p "…"` and `oasis exec` run one task for scripts and CI. `oasis models` lists the models your provider serves, and `oasis update` updates a script-installed copy.

Subagents you or OASIS start show up in `/tasks`: running ones first, finished ones under **Earlier in this session**, even after a restart. `/tasks ID` shows a report, `/tasks send ID MESSAGE` steers or resumes one, and `/tasks stop ID` stops it.

## 5. Browser workspace

### Start it

```sh
cd /path/to/your/project
oasis web --open
```

The terminal prints a private link such as `http://127.0.0.1:3917/app/#token=…`. The access key in the link moves out of the address bar into the tab as soon as the page opens. By default OASIS listens only on this computer and makes a new key on every start.

### Use it from another device

Keep OASIS on loopback and put HTTPS in front of it, for example with Tailscale Serve, Cloudflare Tunnel, Caddy or nginx:

```sh
oasis web --public-url https://oasis.example.com --trust-proxy
```

`--public-url` keeps the same access key across restarts. Open the address on the other device and paste the link or key. `oasis web key` shows the key again, and `oasis web key --rotate` replaces it. [Remote access](REMOTE-ACCESS.md) has copy-paste recipes and the full security model.

<p align="center"><img src="../assets/screenshots/web-sign-in-dark.png" alt="The OASIS sign-in screen asking for the link or access key, with a Remember this device checkbox" width="720"></p>

Tick **Remember this device** on a phone or laptop you own to reconnect without the link. Otherwise the key lives only in that browser tab. Ctrl+K → **Sign out of this browser** forgets it. A key that no longer works (for example after `--rotate`) is dropped, and the sign-in screen says so.

### Follow the work

OASIS narrates as it goes. Short updates in plain words alternate with **execution groups**: each group folds the steps between two updates (files read, edits, commands, searches, subagents) into one line with a step count and duration. Select a group to see each step, and select a step to inspect its exact input and output. Subagents appear inside their group with their task, model and status.

<p align="center"><img src="../assets/screenshots/web-approval-dark.png" alt="An approval request for the npm test command while the step behind it shows as waiting" width="720"></p>

In **Ask first** mode, commands and risky actions wait for you in an approval sheet. The step behind it shows **Waiting**, not **Working**. Close the tab, lose Wi-Fi or reload the page, and the web app reattaches to the running task when it comes back: the timeline is replayed from the server and an open approval is asked again. Answered approvals are not asked twice.

The sidebar (on wide screens) lists this project's tasks with a dot for those still running or waiting on you. Ctrl+B (Cmd+B on macOS) hides or shows it.

### Working in the browser workspace

| Action | How |
| --- | --- |
| Run a command or skill | Type `/` in the message box. Suggestions list built-in commands, your custom commands and skills. Arrow keys move, Tab or Enter accepts, Escape closes. |
| Point at a file | Type `@` and part of a file name, then Tab or Enter to insert the path. The file is attached to the message. |
| Attach a screenshot | Use the image button or paste an image. Text-only models get the message without the image; pick a vision model to use images. |
| Add documents to the project | Open the project menu, choose **Files or zip**, and pick files (PDF, text, images; up to 10 MB each). Protected paths such as `.env` and `.git` are refused, and replacing a file asks first. |
| Switch permission mode | Use the mode chip, or press Shift+Tab in the message box: Ask first, Auto edit, Full auto and Plan. |
| Undo a turn | After a turn that changed files, select **Undo** under the reply. It runs `/undo`, which restores the files and rewinds the conversation. |
| Copy or reuse a message | Hover a message for **Copy** (the original Markdown) and, on your own messages, **Edit**. Code blocks have their own Copy button. |
| Watch the context window | The ring beside the Send button shows how full the context window is. It turns amber at 70% and red at 90%. |
| Know when it's done | In a background tab the page title shows a badge when a task finishes or needs approval. Turn on browser notifications and optional sounds under **Settings**. |
| Use a terminal | Press Ctrl+` and choose **Start terminal** for your own shell in the workspace beside the chat. The agent cannot see it, and reloading the page reconnects to it. |
| Download a chat | Ctrl+K → **Download this chat** saves one HTML page with every tool step, no scripts, credentials redacted. |
| Open everything else | Ctrl+K (Cmd+K on macOS) opens the command palette. Ctrl+/ lists every shortcut. |

The interface follows your system's light or dark theme and honours reduced-motion settings: the particle background, jitter and sweep animations switch off.

## 6. Review every task

Pick a bounded first task with a visible outcome, such as explaining a function, fixing a reproducible bug or adding a focused test.

1. State the outcome you want and any constraints.
2. Read commands and permission requests before approving them.
3. Open **Changes** to inspect every file OASIS touched and its diff.
4. Check the tests OASIS ran, their exit status and output.
5. Commit only after you understand and accept the diff.

`/export review.html` writes a standalone review page; `/export notes.md` writes Markdown. A model saying "done" is not a test result; see [Benchmark methodology](BENCHMARKS.md).

## 7. Security boundaries

- Approval prompts are not a replacement for operating-system isolation.
- Without an active sandbox backend, commands run with the permissions of the OASIS process.
- Linux, macOS and container sandbox backends have platform-specific prerequisites.
- MCP servers, plugins, hooks and imported skills can run third-party code. Review them before enabling.
- Hosted providers may receive prompts, project context and tool output.
- Anyone with the access key controls the workspace. Share it like a password and rotate it if it leaks.

Read [SECURITY.md](../SECURITY.md) before connecting sensitive workspaces.

## Troubleshooting

| Problem | What to check |
|---|---|
| "Paste your OASIS link" on every visit | Tick **Remember this device**, or start with `--public-url` / `--persistent-key` so the key survives restarts. |
| "The saved access key no longer works" | The key was rotated or OASIS restarted without `--persistent-key`. Run `oasis web key` on the server. |
| `421 Misdirected Request` | The host name is not allowed. Pass `--public-url` or `--allow-host`. |
| Provider setup refused from another device | Use HTTPS; keys are accepted only from the same computer or over HTTPS. |
| Provider connection fails | Check the endpoint, model name, network access and credentials. Never paste API keys into an issue. |
| Free model stops answering | Free tiers have rate and daily limits. OASIS moves to a backup model when one runs out; add credits or another key for more. |
| Sandbox unavailable | Do not assume isolation is active; check `oasis doctor`. |
| The result is incorrect | Inspect the diff, ask for a narrow correction and rerun the relevant test. |

## Further reading

- [Remote access](REMOTE-ACCESS.md)
- [Interfaces and deployment](INTERFACES.md)
- [Downloads and releases](RELEASES.md)
- [Configuration](CONFIGURATION.md)
- [Architecture](ARCHITECTURE.md)
- [Security policy](../SECURITY.md)
- [Support](../SUPPORT.md)
