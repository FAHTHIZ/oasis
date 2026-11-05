# OASIS on a phone or tablet

OASIS runs on a phone in four ways. The universal app needs nothing else: no computer, no terminal, no account.

| Option | Works on | What you need |
| --- | --- | --- |
| [Universal app](#universal-app) | Android, iPhone, iPad, ChromeOS, any desktop browser | A browser and a model provider key (or a local model) |
| [Browser workspace from your phone](#browser-workspace-from-your-phone) | iPhone, iPad, Android | OASIS on a computer on the same private network |
| [Chat with your agent](#chat-with-your-agent-telegram-discord-slack) | Any phone | A Telegram, Discord or Slack bot |
| [Run the CLI on the phone (Termux)](#run-oasis-on-the-phone-termux) | Android only | Termux, plus a hosted model or a model on another computer |

## Universal app

Open **[fahthiz.github.io/oasis/app](https://fahthiz.github.io/oasis/app/)** and add it to the home screen:

- **Android, ChromeOS, Windows, macOS, Linux (Chrome or Edge):** tap **Install** in the app, or the browser menu, then **Install app**.
- **iPhone and iPad (Safari):** Share, then **Add to Home Screen**. The app shows this hint the first time.

**One app for every device.** There is no separate Android, iOS or desktop download to keep in sync: the installed web app is the same code everywhere, updates itself the next time it opens, and runs offline once installed. On Android the system back button and gesture close the open panel first, and "share to OASIS" from another app starts a task with the shared text or link.

After installing, it opens full screen with its own icon and works offline. The whole agent runs on the device: the loop, tools, projects and chat history live in the browser, and model requests go straight from the device to the provider you pick. There is no OASIS server in between.

**Getting started takes one paste.** The first screen asks for one thing: an API key, a model link or a server address. Paste it there, or straight into the message box at any time:

- **An API key.** The provider is recognised from the key's shape (OpenRouter `sk-or-…`, Anthropic `sk-ant-…`, Gemini `AIza…`, Groq `gsk_…`, xAI `xai-…`, Hugging Face `hf_…`, NVIDIA `nvapi-…`, and others; ambiguous `sk-…` keys are tried against OpenAI, DeepSeek and Moonshot in turn). OASIS lists the models the key can use, ranks them, sends the best few a small tool-calling test and locks in the first that passes. The progress shows as it happens.
- **A model link.** An Ollama library page (`ollama.com/library/qwen3`) pulls the model into your local Ollama; a Hugging Face model page uses Hugging Face's router; an OpenRouter model page selects that model.
- **A server address.** `http://localhost:11434`, `http://192.168.1.20:8080/v1` or any OpenAI-compatible URL. Ollama, LM Studio and llama.cpp running on the same device are found automatically and offered as one-tap buttons.

Whatever you paste after the key in the same message (for example `sk-or-… fix the failing test`) is sent as your first request once the connection is ready.

**Automatic model fallback.** Every connection keeps a ranked list of working models. When the current one runs out of credit (402), is rate limited (429), overloaded (5xx) or removed (404), the agent moves to the next model, or to another connected provider, in the middle of the task and adds a short note to the chat. Tap the model name at the top to see the order, pick a model yourself, or turn automatic switching off.

**Built-in plugins.** Nine plugins ship with the app: Debugger, Test writer, Code reviewer, Security audit, Web app studio, API builder, Mobile apps, Docs writer and GitHub. Planning, small focused changes and explaining a project are not plugins: the agent does them by default. As you type, the matching plugin appears above the message box; tap it to apply it to this request, or turn it on for the whole project from the plugin sheet. Each plugin adds a short instruction and the skills it needs; none adds new tools or network access.

**Lite mode.** On devices with little memory, few cores, Data Saver or reduced motion, the app switches to lite mode on its own: no animation or blur, fewer repaints while a reply streams, tool output drawn only when you open it, and a shorter transcript kept in memory. Add `?lite=1` to force it on or `?lite=0` to force it off.

**What it does**

- Chat with an agent that reads, writes, edits, searches and deletes files in a project, with a diff for every change and **Revert** per file.
- Runs JavaScript (CommonJS and ES modules, `assert`, and `test`/`describe`/`it`) in an isolated sandbox: a separate origin-locked frame and a worker per run, no network, no access to the app's storage, and a hard time limit that kills infinite loops.
- Imports a GitHub repository (public, or private with a token), a ZIP file or a folder, and exports a ZIP. With a GitHub token it pushes changes as a commit to a new branch and can open a pull request. Pushing always asks first.
- Fetches web pages as Markdown, keeps a to-do list, and loads skills on demand. Bundled skills ship with the app; project skills come from `.oasis/skills`, `.agents/skills` or `.claude/skills` in the project. Only the skill names go into the prompt until one is needed, so it stays light on small models and low-end phones.
- Follows project instructions from `OASIS.md` (or `AGENTS.md` / `CLAUDE.md`).
- Approval modes: **Ask** (approve every change), **Edits** (file edits allowed, risky actions ask) and **Auto**.
- Repairs malformed and text-only tool calls from small models, detects loops, and compacts long conversations.

**Providers:** OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Mistral, xAI, Moonshot, Hugging Face, Together, Fireworks, Cerebras, NVIDIA, Ollama, or any OpenAI-compatible endpoint (llama.cpp, LM Studio, vLLM). You can connect several at once; **Settings → Connections** lists them, and **Manual setup** is still there if you want to type a base URL and model by hand. Keys are stored only in this browser's local storage on this device. For Ollama or llama.cpp on your own computer, allow the app's origin in the server (for Ollama, `OLLAMA_ORIGINS=https://fahthiz.github.io`).

**Links:** `…/app/?repo=owner/name` imports a repository on open, and `?q=…` starts a chat with that request.

**Self-hosting:** `oasis app` serves the same app from your computer (`--lan` shows a QR code for your phone, `--port` changes the port, default 3920). `node scripts/build-app.mjs` writes a static copy to `site/app/` that any static host can serve.

**Limits.** On its own, the universal app cannot run shell commands, install packages or run Python. Opened from `oasis web` or the desktop app (or a phone connected to them, below), the same app drives the agent on that computer, which can. Browser storage can be cleared by the browser under storage pressure, so export a ZIP or push to GitHub for anything you need to keep. It is tested in desktop and mobile-emulated Chromium; real-device testing on iOS Safari and older Android browsers is still in progress.

## Browser workspace from your phone

### The quick way: Connect a phone

In the desktop app choose **File → Connect a phone…**. In the browser workspace open **Settings → Devices → Connect a phone**. You get two choices:

- **Share over Tailscale (encrypted).** Recommended. [Tailscale](https://tailscale.com) encrypts traffic between your own devices and also works away from home. Install it on the computer and the phone and sign in to the same account; the button is greyed out until the computer is connected.
- **Share over Wi-Fi (unencrypted).** For your own home network only. OASIS first shows a warning, and the desktop app uses a native dialog that the page cannot answer by itself. Anyone on the same Wi-Fi could read the traffic, so never use it on public Wi-Fi.

OASIS then shows a QR code and a link. Scan it with the phone camera and add the page to the home screen (below). The phone uses the same chats, runs and approvals as the computer, not a separate copy. **Stop sharing** closes the link and disconnects phones that are already connected. Closing OASIS also closes it.

Behind the scenes OASIS keeps its server on `127.0.0.1` and opens an extra listener only on the chosen private addresses (never on every network interface). The connection token still protects every request, and features that only make sense on the computer itself (provider keys, hardware detection, updates, and phone sharing itself) stay unavailable on the phone.

### From the terminal

1. On the computer, start the workspace so other devices can reach it:

   ```bash
   # Recommended: HTTPS with a certificate the phone trusts (see below)
   oasis web --host 0.0.0.0 --tls-cert oasis.pem --tls-key oasis-key.pem

   # Trusted home network only: plain HTTP, which anyone on the network can read
   oasis web --host 0.0.0.0 --allow-insecure-lan
   ```

   OASIS prints a link for each private network address of the computer and a QR code in the terminal. Set `OASIS_NO_QR=1` to hide the QR code.
2. Scan the QR code with the phone camera, or type the link. The link includes the connection token, so the phone connects without pasting anything.
3. Add it to the home screen. **Settings → Devices → Install OASIS as an app** does this in one tap on Android and desktop Chrome or Edge, and shows the steps on iPhone. Or by hand:
   - **iPhone/iPad:** Share, then **Add to Home Screen**.
   - **Android (Chrome):** the menu, then **Install app** (or **Add to Home screen**).

Approvals, the file browser, the terminal and the update banner all work from the phone. For safety, model API keys can be entered only on the computer itself (`oasis setup`, or the workspace opened on that computer). They are never typed in on a second device.

### A certificate the phone trusts

[mkcert](https://github.com/FiloSottile/mkcert) creates a local certificate authority and certificates for your computer's address:

```bash
mkcert -install
mkcert -cert-file oasis.pem -key-file oasis-key.pem 192.168.1.42   # your computer's LAN address
```

Install the mkcert root certificate on the phone (`mkcert -CAROOT` shows where it is). On iOS, also turn it on under Settings → General → About → Certificate Trust Settings. The certificate must list the exact address you open, because OASIS accepts only literal IP addresses (not host names), as protection against DNS rebinding.

### Rules that always apply

- Use a private network you trust. Never forward the port to the Internet.
- Anyone with the link (it contains the token) can use the workspace while it runs. Stop the server with Ctrl+C when you are done; the next start creates a new token.
- [Tailscale](https://tailscale.com/) addresses (100.64.0.0/10) are listed too. Start with `--allow-insecure-lan` and open `http://100.x.y.z:PORT/` from a phone on the same tailnet. This works from anywhere, and Tailscale encrypts the traffic, though the flag still lets devices on your local network reach the port.

## Chat with your agent (Telegram, Discord, Slack)

`oasis gateway telegram` (or `discord`, `slack`) connects the agent on your computer to a bot. Send tasks, answer approvals and send voice notes from any phone. See [Telegram gateway](USER_GUIDE.md#telegram-gateway-your-agent-from-your-phone).

## Run OASIS on the phone (Termux)

On Android, OASIS itself runs inside [Termux](https://termux.dev/). Phone processors are too slow for local models, so use a hosted model or point OASIS at a model server on another computer. See [TERMUX.md](TERMUX.md).

## Updates

The web app on the home screen always loads from the computer you connect to, so updating OASIS there (`oasis update`, or the desktop app's **Install and restart**) updates the phone too. When a new stable version is published, the update banner tells you on every device.
