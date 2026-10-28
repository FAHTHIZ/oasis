// OS secure storage for secrets such as sensitive plugin userConfig values.
//
// Backends:
//   - macOS: the login keychain via `security` (generic password).
//   - Linux: the Secret Service (GNOME Keyring, KWallet) via `secret-tool`.
//   - Windows / anything else: no keychain; callers fall back to a 0600 file.
//
// OASIS_SECURE_STORAGE=file forces the file fallback, =keychain forces the macOS
// backend and =libsecret forces the Secret Service backend.
// Values are passed on stdin where the tool allows it, never through argv on Linux.

import { spawnSync } from 'node:child_process';

const SERVICE = 'oasis';

export function secureStoreBackend(env = process.env, platform = process.platform) {
  const forced = String(env.OASIS_SECURE_STORAGE || '').toLowerCase();
  if (forced === 'file' || forced === 'none' || forced === 'off') return null;
  if (forced === 'keychain') return 'keychain';
  if (forced === 'libsecret' || forced === 'secret-tool') return 'libsecret';
  if (platform === 'darwin') return 'keychain';
  if (platform === 'linux') return 'libsecret';
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, input: options.input, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: result.status === 0, stdout: String(result.stdout || ''), error: String(result.stderr || '').trim() };
}

/** Read a secret. Returns null when it is missing or the backend is unavailable. */
export function secureGet(account, env = process.env, backend = secureStoreBackend(env)) {
  if (backend === 'keychain') {
    const result = run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { env });
    return result.ok ? result.stdout.replace(/\n$/, '') : null;
  }
  if (backend === 'libsecret') {
    const result = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { env });
    return result.ok && result.stdout ? result.stdout.replace(/\n$/, '') : null;
  }
  return null;
}

/** Store a secret. Returns { ok, backend, error }. */
export function secureSet(account, value, env = process.env, backend = secureStoreBackend(env)) {
  if (backend === 'keychain') {
    // -U updates an existing item. `security` has no stdin mode for -w in batch use.
    const result = run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-l', 'Oasis: ' + account, '-w', value], { env });
    return { ok: result.ok, backend, error: result.ok ? null : result.error };
  }
  if (backend === 'libsecret') {
    const result = run('secret-tool', ['store', '--label=Oasis: ' + account, 'service', SERVICE, 'account', account], { env, input: value });
    return { ok: result.ok, backend, error: result.ok ? null : result.error };
  }
  return { ok: false, backend: null, error: 'No OS secure storage on this platform.' };
}

export function secureDelete(account, env = process.env, backend = secureStoreBackend(env)) {
  if (backend === 'keychain') return run('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { env }).ok;
  if (backend === 'libsecret') return run('secret-tool', ['clear', 'service', SERVICE, 'account', account], { env }).ok;
  return false;
}
