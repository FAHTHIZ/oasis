# Phone connection security note

**Status: design note only. Phone pairing and remote access are not implemented by this document.**

OASIS currently keeps the browser workspace local to the computer. Connecting a phone would expand the trust boundary: someone who can reach the service may be able to read project context, request edits, or ask the agent to run commands. Treat this as a security-sensitive feature, not just a networking option.

## Assets to protect

- Project files and source code.
- Provider API keys, access tokens, session cookies, and pairing credentials.
- Agent conversations, tool output, task history, and diffs.
- Approval decisions and commands that can change or delete files.
- The user's ability to stop work and revoke access.

## Threats

1. **Untrusted device on the same Wi-Fi:** another device scans for open ports and tries to reach the workspace.
2. **Guessable or replayed pairing:** an attacker reuses an old QR code or guesses a pairing secret.
3. **Stolen paired phone:** a lost device continues to access project data.
4. **Network interception:** a person between the phone and computer reads or alters traffic.
5. **Browser-origin abuse / CSRF:** a malicious website attempts to make the browser issue authenticated requests.
6. **Approval fatigue:** a phone UI hides what a command will do or makes accidental approval easy.
7. **Secret leakage:** credentials appear in QR codes, URLs, logs, screenshots, crash reports, or model-visible output.
8. **Tunnel misconfiguration:** a user exposes a local service to the public internet without understanding the consequences.
9. **Stale or interrupted work:** the phone shows a pending approval or running job that no longer exists.

## Minimum requirements before implementation

- Keep phone access **off by default**. Do not bind a public interface or open a public port automatically.
- Require an explicit local opt-in and one-time pairing code with sufficient randomness, short expiry, and single use.
- Exchange the pairing code for a per-device random token. Store only what is needed, avoid putting tokens in URLs, and never log them.
- Provide a paired-device list, last-used information where available, and immediate revocation. Revocation must invalidate the token server-side.
- Authenticate every API and event-stream request; apply CSRF/origin protections and rate limits to pairing attempts.
- Prefer a private network or a private tunnel chosen and configured by the user. Explain that a tunnel changes who can reach the service.
- Refuse plaintext HTTP over the public internet. Do not claim that ordinary LAN HTTP is end-to-end encrypted.
- Preserve existing workspace authentication and approval checks. A phone must not gain broader permissions than the desktop session.
- Show the exact target and consequence for destructive actions and installs. Keep Allow and Deny separate, large, and keyboard/screen-reader accessible.
- Include an always-visible **Pause everything** control that cancels active work and blocks new actions until resumed.
- Make expired, revoked, disconnected, and interrupted states explicit. Never show a stale approval as actionable.
- Keep provider keys out of the phone UI unless a separate, reviewed design explicitly requires them.
- Test hostile origins, token expiry/revocation, replay, unauthorized API calls, disconnect/reconnect, and destructive-action denial.

## Release gate

Do not implement or announce phone pairing until the core safety brief is completed and reviewed, the threat cases above have tests, and the implementation has been tested on a real phone. Passing unit tests alone is not evidence that network exposure is safe.

## Not covered

This note is not a penetration test, a complete security audit, or approval to expose the current local server remotely. The current local-only behavior should remain the default.
