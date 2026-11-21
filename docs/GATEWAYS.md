# Messaging gateways

`oasis gateway PLATFORM` lets you talk to the OASIS agent of one workspace from a chat app. Each chat (or room, thread, channel) gets its own saved session, approvals come to you in the chat, and anything unanswered for ten minutes is rejected. Only allowlisted people can use the agent: anybody else gets one reply that shows them their ID, so you can add it if you meant to.

While a gateway is running it also hosts your [routines](USER-GUIDE.md#routines-that-run-on-a-schedule), and a routine can deliver its output to any of these platforms with `--deliver PLATFORM:TARGET`.

| Platform | Command | Approvals | Routine delivery |
| --- | --- | --- | --- |
| Telegram | `oasis gateway telegram` | Buttons | `telegram:CHAT_ID` |
| Discord | `oasis gateway discord` | Buttons | `discord:CHANNEL_ID` |
| Slack | `oasis gateway slack` | Buttons | `slack:CHANNEL` |
| Matrix (Element and any homeserver) | `oasis gateway matrix` | Typed replies | `matrix:!ROOM_ID:server` |
| Signal (through signal-cli REST API) | `oasis gateway signal` | Typed replies | `signal:+NUMBER` or `signal:group.ID` |
| Email (IMAP and SMTP) | `oasis gateway email` | Typed replies | `email:ADDRESS` |

## Chat commands

`/new` starts a fresh session, `/stop` cancels the running task, `/status` shows the session, `/mode default|acceptEdits|plan|auto` changes how approvals work and `/help` lists these. Every command also works with `!` instead of `/` (Slack reserves `/`).

On platforms without buttons, answer an approval by replying `yes` or `no`. When more than one approval is waiting, include its number: `allow 3`, `always 3` or `reject 3`.

Files, photos and voice notes you send are saved under `.oasis/inbox/` in the workspace. Images are shown to the model, and voice notes are transcribed when voice transcription is set up.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Set `OASIS_TELEGRAM_BOT_TOKEN` and `OASIS_TELEGRAM_ALLOWED_CHATS` (comma-separated numeric chat IDs; message the bot once to see yours).
3. Run `oasis gateway telegram`.

## Discord

1. Create an application and bot in the Developer Portal, and enable the **Message Content** intent.
2. Set `OASIS_DISCORD_BOT_TOKEN` and `OASIS_DISCORD_ALLOWED_USERS` (Discord user IDs). Optional: `OASIS_DISCORD_CHANNELS` lists channels where every message is a task; elsewhere the bot answers DMs and mentions.
3. Run `oasis gateway discord`.

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

- From addresses are easy to forge. A message only counts when your mail provider's `Authentication-Results` header shows `dmarc=pass`, or `dkim=pass` for the sender's own domain. Gmail, Outlook, Fastmail and most hosted providers add this header. For a private server that adds none, set `OASIS_EMAIL_REQUIRE_AUTH=0` and make sure only trusted senders can reach the mailbox.
- Auto-replies, mailing lists, bulk mail and bounces are ignored, and the agent's own mail carries `Auto-Submitted: auto-replied`, so it never loops with another robot.
