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

After installing, it opens full screen with its own icon and works offline. The whole agent runs on the device: the loop, tools, projects and chat history live in the browser, and model requests go straight from the device to the provider you pick. There is no OASIS server in between.

**What it does**

- Chat with an agent that reads, writes, edits, searches and deletes files in a project, with a diff for every change and **Revert** per file.
- Runs JavaScript (CommonJS and ES modules, `assert`, and `test`/`describe`/`it`) in an isolated sandbox: a separate origin-locked frame and a worker per run, no network, no access to the app's storage, and a hard time limit that kills infinite loops.
- Imports a GitHub repository (public, or private with a token), a ZIP file or a folder, and exports a ZIP. With a GitHub token it pushes changes as a commit to a new branch and can open a pull request. Pushing always asks first.
- Fetches web pages as Markdown, keeps a to-do list, and loads skills on demand. Bundled skills ship with the app; project skills come from `.oasis/skills`, `.agents/skills` or `.claude/skills` in the project. Only the skill names go into the prompt until one is needed, so it stays light on small models and low-end phones.
- Follows project instructions from `OASIS.md` (or `AGENTS.md` / `CLAUDE.md`).
- Approval modes: **Ask** (approve every change), **Edits** (file edits allowed, risky actions ask) and **Auto**.
- Repairs malformed and text-only tool calls from small models, detects loops, and compacts long conversations.

**Providers:** OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Mistral, xAI, Ollama, or any OpenAI-compatible endpoint (llama.cpp, LM Studio, vLLM). Keys are stored only in this browser's local storage on this device. For Ollama or llama.cpp on your own computer, allow the app's origin in the server (for Ollama, `OLLAMA_ORIGINS=https://fahthiz.github.io`).

**Links:** `…/app/?repo=owner/name` imports a repository on open, and `?q=…` starts a chat with that request.

**Self-hosting:** `oasis app` serves the same app from your computer (`--lan` shows a QR code for your phone, `--port` changes the port, default 3920). `node scripts/build-app.mjs` writes a static copy to `site/app/` that any static host can serve.

**Limits.** The universal app cannot run shell commands, install packages or run Python. Use the CLI, desktop app or browser workspace for that, or connect your phone to them (below). Browser storage can be cleared by the browser under storage pressure, so export a ZIP or push to GitHub for anything you need to keep. It is tested in desktop and mobile-emulated Chromium; real-device testing on iOS Safari and older Android browsers is still in progress.

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
