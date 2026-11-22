# Messaging gateways

`oasis gateway PLATFORM` lets you talk to the OASIS agent of one workspace from a chat app. Each chat (or room, thread, channel) gets its own saved session, approvals come to you in the chat, and anything unanswered for ten minutes is rejected. Only allowlisted or [paired](#pairing) people can use the agent: anybody else gets one reply that shows them their ID and a pairing code, so you can let them in if you meant to.

While a gateway is running it also hosts your [routines](USER-GUIDE.md#routines-that-run-on-a-schedule), and a routine can deliver its output to any of these platforms with `--deliver PLATFORM:TARGET`.

| Platform | Command | Approvals | Routine delivery |
| --- | --- | --- | --- |
| Telegram | `oasis gateway telegram` | Buttons | `telegram:CHAT_ID` |
| Discord | `oasis gateway discord` | Buttons | `discord:CHANNEL_ID` |
| Slack | `oasis gateway slack` | Buttons | `slack:CHANNEL` |
| Matrix (Element and any homeserver) | `oasis gateway matrix` | Typed replies | `matrix:!ROOM_ID:server` |
| Signal (through signal-cli REST API) | `oasis gateway signal` | Typed replies | `signal:+NUMBER` or `signal:group.ID` |
| Email (IMAP and SMTP) | `oasis gateway email` | Typed replies | `email:ADDRESS` |
| WhatsApp (official Cloud API) | `oasis gateway whatsapp` | Buttons | `whatsapp:+NUMBER` |
| Mattermost | `oasis gateway mattermost` | Typed replies | `mattermost:CHANNEL_ID` |

## Pairing

You do not have to collect IDs before starting a gateway. When somebody who is not on the allowlist messages the bot, they get a one-time code such as `K7QM-4XHP`, and the gateway log prints the same code. Approve it on the OASIS machine:

```bash
oasis gateway pair K7QM-4XHP     # let them in
oasis gateway paired             # who is paired, and who is waiting
oasis gateway unpair discord:1234567890
```

Codes expire after an hour and are tied to the platform and ID that asked for them, so a code from Slack cannot approve a Telegram chat. Approvals are stored per workspace in `.oasis/gateway/pairing.json` (mode 600) and take effect immediately, without a restart. With pairing on, the `ALLOWED_*` variables become optional for Telegram, Discord, Slack, Matrix, Signal, WhatsApp and Mattermost; they still work and are checked first. Email always needs `OASIS_EMAIL_ALLOWED_SENDERS`, because replying with codes to unknown senders would turn the bot into a spam source.

Set `OASIS_GATEWAY_PAIRING=0` to turn pairing off: strangers then only see their ID, and every gateway requires its allowlist again.

## Every platform at once

`oasis gateway all` starts every platform whose token is set (`OASIS_TELEGRAM_BOT_TOKEN`, `OASIS_DISCORD_BOT_TOKEN`, `OASIS_SLACK_BOT_TOKEN`, `OASIS_MATRIX_ACCESS_TOKEN`, `OASIS_SIGNAL_NUMBER`, `OASIS_EMAIL_USER`, `OASIS_WHATSAPP_TOKEN` or `OASIS_MATTERMOST_TOKEN`) in one process, with one routine scheduler. Log lines are prefixed with the platform. If a platform is only half configured, startup stops with that platform's error, and if one platform loses its connection later, the others keep answering.

## Chat commands

`/new` (or `/reset`) starts a fresh session, `/stop` cancels the running task, `/status` shows the session, `/mode default|acceptEdits|plan|auto` changes how approvals work (up to the gateway's ceiling, see below), `/resume` [continues a saved session](#continue-anywhere), `/sethome` makes the chat your [home channel](#home-channel), `/home` shows which chat that is, `/personality NAME` changes the agent's [voice](CONFIGURATION.md#personalities) for that chat, and `/help` lists these.

A chat can loosen approvals only up to a ceiling set by whoever runs the gateway: `OASIS_GATEWAY_MAX_MODE` (`plan`, `manual`, `accept-edits` or `auto`), else the mode the gateway was started in (`oasis gateway --permission-mode auto ...`), else `accept-edits`. So `/mode auto` from a chat is refused unless you allowed it, and a leaked or shared chat account cannot turn off command approvals.

The session commands from the terminal work in chats too: `/model [NAME]` shows or switches the model, `/effort LEVEL` sets reasoning effort, `/compress` (or `/compact`) shrinks the context at once, `/usage` shows that chat's tokens and cost, `/context` shows what fills the context, `/insights [DAYS]` summarizes recent sessions, `/undo` removes the last turn and its file edits, and `/retry` runs your last request again (its edits stay; send `/undo` first to drop them). `/skills` lists skills, and `/SKILL-NAME [request]` runs one, as in the terminal. Every command also works with `!` instead of `/` (Slack reserves `/`).

On platforms without buttons, answer an approval by replying `yes` or `no`. When more than one approval is waiting, include its number: `allow 3`, `always 3` or `reject 3`.

Files, photos and voice notes you send are saved under `.oasis/inbox/` in the workspace. Images are shown to the model, and voice notes are transcribed when voice transcription is set up.

## Continue anywhere

Every chat saves its conversation as a normal OASIS session, and `/resume` lets any chat continue any saved session of the workspace: one you started in the terminal, in the web app or on another platform. `/resume` alone lists the recent ones; `/resume 1`, `/resume last` or `/resume ID-PREFIX` picks one. The chat then keeps saving to the same session ID, so `oasis --resume ID` back at the desk picks up what you did from your phone.

Only one place should drive a session at a time: if it is still open in a terminal, the two copies diverge and the last one saved wins.

## Home channel

Send `/sethome` in the chat where you want results to arrive, on any platform. Routines created with `--deliver home` then post there, so you can move them from Telegram to Slack by sending `/sethome` in Slack without editing a single routine:

```bash
oasis schedule add "weekdays at 9am" "Summarize yesterday's CI failures" --deliver home
```

There is one home channel per OASIS profile, stored in `gateway-home.json` in the config directory. For threaded platforms (Slack, Mattermost) the home is the channel, not the thread. A routine whose target is `home` while none is set is reported as blocked instead of running.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Set `OASIS_TELEGRAM_BOT_TOKEN` and `OASIS_TELEGRAM_ALLOWED_CHATS` (comma-separated numeric chat IDs; message the bot once to see yours).
3. Run `oasis gateway telegram`.

On start the bot registers its command menu with Telegram (`setMyCommands`), so typing `/` lists `/new`, `/stop`, `/retry`, `/model`, `/usage` and the other chat commands with a short description. Set `OASIS_TELEGRAM_COMMAND_MENU=0` to keep a menu you manage in BotFather.

## Discord

1. Create an application and bot in the Developer Portal, and enable the **Message Content** intent.
2. Set `OASIS_DISCORD_BOT_TOKEN` and `OASIS_DISCORD_ALLOWED_USERS` (Discord user IDs). Optional: `OASIS_DISCORD_CHANNELS` lists channels where every message is a task; elsewhere the bot answers DMs and mentions.
3. Run `oasis gateway discord`.

On connect the bot registers Discord slash commands: `/ask task:` gives the agent a task without mentioning the bot, and `/new`, `/stop`, `/retry`, `/model`, `/usage`, `/resume` and the other chat commands run as if typed. Only allowlisted users can use them; anyone else gets a private reply with their user ID or a pairing code. New global commands can take a few minutes to appear in Discord. Set `OASIS_DISCORD_SLASH_COMMANDS=0` to skip registration.

## Slack

1. Create a Slack app with Socket Mode on. Give the bot token `chat:write`, `app_mentions:read`, `im:history` (and `files:read` for attachments).
2. Set `OASIS_SLACK_APP_TOKEN` (`xapp-…`), `OASIS_SLACK_BOT_TOKEN` (`xoxb-…`) and `OASIS_SLACK_ALLOWED_USERS` (member IDs such as `U012ABC`).
3. Run `oasis gateway slack`.

## Matrix

Works with Element and any Matrix homeserver over the standard Client-Server API. No extra software is needed.

1. Create an account for the bot on your homeserver and copy its access token (Element: **Settings → Help & About → Access token**).
2. Set:
   - `OASIS_MATRIX_HOMESERVER`, for example `https://matrix.example.org`
   - `OASIS_MATRIX_ACCESS_TOKEN`
   - `OASIS_MATRIX_ALLOWED_USERS`, for example `@me:example.org`
   - optional `OASIS_MATRIX_ROOMS`: room IDs where every message is a task. Elsewhere the bot answers direct rooms (two members) and messages that mention it.
3. Run `oasis gateway matrix`, then invite the bot to a room. It joins rooms an allowlisted user invites it to and declines every other invite.

The gateway never replays room history after a restart. End-to-end encrypted rooms are not supported: the bot says so once and ignores encrypted messages, so use an unencrypted room for it.

## Signal

Signal has no bot API, so OASIS talks to [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api), the open-source bridge most self-hosted Signal bots use. Give the bot its own number if you can: messages you send from the bot's number to yourself are ignored.

1. Start the bridge (json-rpc mode keeps one WebSocket open):

   ```sh
   docker run -d --name signal-api -p 127.0.0.1:8080:8080 \
     -v "$HOME/.local/share/signal-api:/home/.local/share/signal-cli" \
     -e MODE=json-rpc bbernhard/signal-cli-rest-api
   ```

2. Register a number or link the bridge to an existing Signal account as a secondary device (open `http://127.0.0.1:8080/v1/qrcodelink?device_name=oasis` and scan it from Signal → **Linked devices**).
3. Set:
   - `OASIS_SIGNAL_API_URL=http://127.0.0.1:8080`
   - `OASIS_SIGNAL_NUMBER`, the bot's number, for example `+15551234567`
   - `OASIS_SIGNAL_ALLOWED_USERS`: phone numbers or Signal UUIDs
   - optional `OASIS_SIGNAL_GROUPS`: group IDs where every message is a task. In other groups the bot answers only when mentioned.
   - optional `OASIS_SIGNAL_MODE=normal` if the bridge runs in `normal` or `native` mode (OASIS then polls `/v1/receive`).
4. Run `oasis gateway signal`.

Keep the bridge on `127.0.0.1` or a private network: it has no authentication of its own.

## Email

Email the agent from any mail app. OASIS watches a mailbox over IMAP (with IDLE, so new mail shows up within seconds) and answers over SMTP in the same thread. Each thread is its own session, and replying to the agent's message continues it.

1. Create a mailbox for the agent (or use an alias) and an app password for it. For Gmail: turn on 2-Step Verification, then create an app password.
2. Set:
   - `OASIS_EMAIL_IMAP_HOST` (Gmail: `imap.gmail.com`) and `OASIS_EMAIL_SMTP_HOST` (Gmail: `smtp.gmail.com`)
   - `OASIS_EMAIL_USER` and `OASIS_EMAIL_PASSWORD`
   - `OASIS_EMAIL_ALLOWED_SENDERS`: addresses, or `@yourcompany.com` for a whole domain
   - optional: `OASIS_EMAIL_ADDRESS` (the From address, default the user), `OASIS_EMAIL_FROM_NAME`, `OASIS_EMAIL_IMAP_PORT` (993), `OASIS_EMAIL_SMTP_PORT` (465; 587 uses STARTTLS), `OASIS_EMAIL_MAILBOX` (`INBOX`)
3. Run `oasis gateway email`.

The subject and body of a new email become the task. In a reply, only your new text counts: the quoted message, `On … wrote:` blocks and your signature are dropped, so replying `yes` answers an approval. Attachments are saved to `.oasis/inbox/`. Only mail that arrives after the gateway starts is read, and each message is marked as read.

Safety:

- From addresses are easy to forge. A message only counts when your mail provider's `Authentication-Results` header shows `dmarc=pass`, or `dkim=pass` for the sender's own domain. Gmail, Outlook, Fastmail and most hosted providers add this header. Only the receiving server's own header counts (the topmost one), so a sender cannot pass by adding a forged `Authentication-Results` line. Set `OASIS_EMAIL_AUTHSERV_ID` to your server's id (the text before the first `;` in that header, `mx.google.com` for Gmail; several ids comma-separated) to read only headers with that id. For a private server that adds none, set `OASIS_EMAIL_REQUIRE_AUTH=0` and make sure only trusted senders can reach the mailbox.
- Auto-replies, mailing lists, bulk mail and bounces are ignored, and the agent's own mail carries `Auto-Submitted: auto-replied`, so it never loops with another robot.

## WhatsApp

OASIS talks to WhatsApp through Meta's official [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api), so no phone has to stay online and no unofficial client can get the number banned. Meta delivers messages to a webhook that the gateway serves.

1. In the [Meta developer dashboard](https://developers.facebook.com/apps), create an app, add the WhatsApp product and note the phone number ID. Create a permanent access token for a system user with the `whatsapp_business_messaging` permission.
2. Set:
   - `OASIS_WHATSAPP_TOKEN` and `OASIS_WHATSAPP_PHONE_NUMBER_ID`
   - `OASIS_WHATSAPP_APP_SECRET`: the app secret (App settings, Basic), used to check that each webhook call really comes from Meta
   - `OASIS_WHATSAPP_VERIFY_TOKEN`: any random string of 8 or more characters
   - `OASIS_WHATSAPP_ALLOWED_USERS`: phone numbers in international format, for example `+15551112222`
   - optional: `OASIS_WHATSAPP_HOST` (`127.0.0.1`) and `OASIS_WHATSAPP_PORT` (`8787`)
3. Run `oasis gateway whatsapp`, then expose it over HTTPS, for example with `cloudflared tunnel --url http://127.0.0.1:8787` or a reverse proxy.
4. In the WhatsApp configuration page, set the callback URL to `https://YOUR-HOST/webhook`, enter the same verify token and subscribe to the `messages` field.

Approvals arrive as Allow, Always and Reject buttons. Photos, voice notes and documents are downloaded to `.oasis/inbox/`; voice notes are transcribed when a transcription model is configured. Webhook calls without a valid `X-Hub-Signature-256` signature are rejected, and Meta's retries are processed only once.

WhatsApp only lets a business send free-form messages within 24 hours of the person's last message. A routine delivered with `whatsapp:+NUMBER` therefore reaches you only if you wrote to the agent in the last day; otherwise the delivery fails with a clear error.

## Mattermost

1. In Mattermost, open Integrations, Bot Accounts, add a bot and copy its access token. (Bot accounts must be enabled by an admin in System Console, Integrations, Bot Accounts; a personal access token also works.) Add the bot to the teams and channels where it should answer.
2. Set:
   - `OASIS_MATTERMOST_URL`: your server, for example `https://chat.example.com`
   - `OASIS_MATTERMOST_TOKEN`
   - `OASIS_MATTERMOST_ALLOWED_USERS`: usernames (`alice`) or user IDs
   - optional: `OASIS_MATTERMOST_CHANNELS`: channel IDs where every message is a task
3. Run `oasis gateway mattermost`.

The bot answers direct messages and posts that @mention it; in a channel listed in `OASIS_MATTERMOST_CHANNELS` it answers every post. A direct message chat is one session. In a channel, each thread is its own session and the agent replies inside the thread. Approvals are typed replies. Attached files are saved to `.oasis/inbox/`.
