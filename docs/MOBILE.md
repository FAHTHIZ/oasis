# OASIS on a phone or tablet

OASIS does its work (reading files, running commands, calling the model) on a computer. A phone is a remote control for that computer. There are three ways to use it from Android, iPhone or iPad.

| Option | Works on | What you need |
| --- | --- | --- |
| [Browser workspace from your phone](#browser-workspace-from-your-phone) | iPhone, iPad, Android | OASIS on a computer on the same private network |
| [Chat with your agent](#chat-with-your-agent-telegram-discord-slack) | Any phone | A Telegram, Discord or Slack bot |
| [Run OASIS on the phone (Termux)](#run-oasis-on-the-phone-termux) | Android only | Termux, plus a hosted model or a model on another computer |

There is no App Store or Play Store app. The browser workspace installs to the home screen as a web app instead, with its own icon, full-screen window and offline shell.

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
