import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const MAX_SECRET_BYTES = 16 * 1024;

/**
 * One async interface over Electron's safeStorage. Electron 45 deprecated the
 * synchronous methods (removed in 46), so the async ones are used when present
 * and the synchronous ones only as a fallback for older runtimes and tests.
 * On Linux, the "basic_text" backend (no keyring) encrypts with a hard-coded
 * password, so it counts as unavailable: OASIS never calls that protected.
 */
export function secureStoreFrom(safeStorage, { platform = process.platform } = {}) {
  if (!safeStorage) return null;
  const hasAsync = typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
    typeof safeStorage.encryptStringAsync === 'function' && typeof safeStorage.decryptStringAsync === 'function';
  const plainTextBackend = () => {
    if (platform !== 'linux' || typeof safeStorage.getSelectedStorageBackend !== 'function') return false;
    try { return safeStorage.getSelectedStorageBackend() === 'basic_text'; } catch { return false; }
  };
  return {
    async available() {
      try {
        if (plainTextBackend()) return false;
        if (hasAsync) return Boolean(await safeStorage.isAsyncEncryptionAvailable());
        return typeof safeStorage.isEncryptionAvailable === 'function' && Boolean(safeStorage.isEncryptionAvailable());
      } catch { return false; }
    },
    async encrypt(value) {
      return hasAsync ? safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value);
    },
    async decrypt(buffer) {
      if (!hasAsync) return safeStorage.decryptString(buffer);
      const out = await safeStorage.decryptStringAsync(buffer);
      return out && typeof out === 'object' ? out.result : out;
    }
  };
}

const storeOf = (safeStorage) => (safeStorage && typeof safeStorage.available === 'function' ? safeStorage : secureStoreFrom(safeStorage));

/** Whether the OS key store can protect a secret right now. */
export async function secureStorageAvailable(safeStorage) {
  const store = storeOf(safeStorage);
  return Boolean(store && await store.available());
}

/**
 * Read an encrypted desktop API key. Missing, corrupt, or unavailable stores
 * produce an empty result so a damaged secret file never prevents startup.
 */
export async function loadDesktopApiKey({ filePath, safeStorage, fs = { readFile } } = {}) {
  const store = storeOf(safeStorage);
  if (!filePath || !store) return '';
  try {
    if (!(await store.available())) return '';
    const raw = await fs.readFile(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES) return '';
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || typeof saved.encryptedApiKey !== 'string') return '';
    const encrypted = Buffer.from(saved.encryptedApiKey, 'base64');
    if (!encrypted.length) return '';
    const value = await store.decrypt(encrypted);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * Save a key only when OS-backed encryption is available.
 * An empty key removes the desktop-only secret file.
 */
export async function saveDesktopApiKey(apiKey, { filePath, safeStorage, fs = { mkdir, readFile, rm, writeFile, chmod } } = {}) {
  if (!filePath) throw new Error('A secure storage location is required.');
  if (!apiKey) {
    await fs.rm(filePath, { force: true });
    return { saved: false };
  }
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
    throw new Error('The API key is invalid or too long.');
  }
  const store = storeOf(safeStorage);
  if (!store || !(await store.available())) {
    throw new Error('System secure storage is unavailable. OASIS did not save the API key. Enable your operating-system key store, or configure the provider from the terminal instead.');
  }
  const encrypted = await store.encrypt(apiKey);
  if (!Buffer.isBuffer(encrypted) || !encrypted.length) {
    throw new Error('The operating-system secure store did not encrypt the API key. OASIS did not save it.');
  }
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const contents = JSON.stringify({ version: 1, encryptedApiKey: encrypted.toString('base64') }) + '\n';
  await fs.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(target, 0o600); } catch { /* Windows does not support POSIX mode bits. */ }
  return { saved: true };
}
