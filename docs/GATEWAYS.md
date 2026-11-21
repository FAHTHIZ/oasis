# Messaging gateways

`oasis gateway PLATFORM` lets you talk to the OASIS agent of one workspace from a chat app. Each chat (or room, thread, channel) gets its own saved session, approvals come to you in the chat, and anything unanswered for ten minutes is rejected. Only allowlisted people can use the agent: anybody else gets one reply that shows them their ID, so you can add it if you meant to.

While a gateway is running it also hosts your [routines](USER-GUIDE.md#routines-that-run-on-a-schedule), and a routine can deliver its output to any of these platforms with `--deliver PLATFORM:TARGET`.

| Platform | Command | Approvals | Routine delivery |
| --- | --- | --- | --- |
| Telegram | `oasis gateway telegram` | Buttons | `telegram:CHAT_ID` |
| Discord | `oasis gateway discord` | Buttons | `discord:CHANNEL_ID` |
| Slack | `oasis gateway slack` | Buttons | `slack:CHANNEL` |
| Matrix (Element and any homeserver) | `oasis gateway matrix` | Typed replies | `matrix:!ROOM_ID:server` |

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
