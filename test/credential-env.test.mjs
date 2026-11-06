import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialEnvName } from '../src/credential-env.mjs';
import { scrubEnvironment } from '../src/tools.mjs';

test('child-process environments drop every common credential name', () => {
  // Regression: DATABASE_URL, MYSQL_PWD, *_PASSPHRASE, NPM_CONFIG__AUTH, SENTRY_DSN,
  // SLACK_WEBHOOK_URL and *_PAT reached commands and hooks; eval agents also kept
  // AWS_ACCESS_KEY_ID because their copy of the pattern had lost ACCESS_KEY.
  const secrets = ['OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GITHUB_TOKEN', 'PGPASSWORD', 'MYSQL_PWD',
    'DATABASE_URL', 'MONGO_CONNECTION_STRING', 'SENTRY_DSN', 'SLACK_WEBHOOK_URL', 'GPG_PASSPHRASE', 'NPM_CONFIG__AUTH', 'DOCKER_AUTH_CONFIG', 'AZURE_DEVOPS_PAT', 'LDAP_PASSWD', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const ordinary = ['PATH', 'HOME', 'PWD', 'OLDPWD', 'SSH_AUTH_SOCK', 'LANG', 'TERM', 'NODE_ENV', 'AUTHOR', 'PATH_INFO', 'KEYBOARD', 'GIT_TERMINAL_PROMPT'];
  for (const key of secrets) assert.equal(credentialEnvName(key), true, key);
  for (const key of ordinary) assert.equal(credentialEnvName(key), false, key);
  const env = Object.fromEntries([...secrets, ...ordinary].map((key) => [key, 'value']));
  const scrubbed = scrubEnvironment(env);
  for (const key of secrets) assert.equal(key in scrubbed, false, key);
  for (const key of ordinary) assert.equal(scrubbed[key], 'value', key);
  assert.equal(scrubEnvironment({ ...env, OASIS_COMMAND_ENV_ALLOWLIST: 'DATABASE_URL' }).DATABASE_URL, 'value');
});
