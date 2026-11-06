// Environment variable names that carry credentials. Child processes the agent
// starts (commands, hooks, eval agents) get the environment without them.
// One list, so the copies cannot drift apart (eval.mjs had lost ACCESS_KEY).
const CREDENTIAL_NAME = /(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|(?:^|_)AUTH(?:$|_)|_PWD$|(?:^|_)DSN$|DATABASE_URL|CONNECTION_STRING|WEBHOOK_URL|(?:^|_)PAT$)/i;
// Not credentials themselves: the ssh-agent socket git needs, and auth-related settings.
const NOT_CREDENTIAL = new Set(['SSH_AUTH_SOCK', 'GIT_TERMINAL_PROMPT', 'GPG_TTY']);

export function credentialEnvName(key) {
  const name = String(key || '');
  return !NOT_CREDENTIAL.has(name.toUpperCase()) && CREDENTIAL_NAME.test(name);
}
