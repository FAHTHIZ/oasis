import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const MAX_SECRET_BYTES = 16 * 1024;

/**
 * Read an encrypted desktop API key. Missing, corrupt, or unavailable stores
 * produce an empty result so a damaged secret file never prevents startup.
 */
export async function loadDesktopApiKey({ filePath, safeStorage, fs = { readFile } } = {}) {
  if (!filePath || !safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return '';
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    const raw = await fs.readFile(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES) return '';
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || typeof saved.encryptedApiKey !== 'string') return '';
    const encrypted = Buffer.from(saved.encryptedApiKey, 'base64');
    if (!encrypted.length) return '';
    const value = safeStorage.decryptString(encrypted);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * Save a key only when Electron's OS-backed encryption is available.
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
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    throw new Error('System secure storage is unavailable. OASIS did not save the API key. Enable your operating-system key store, or configure the provider from the terminal instead.');
  }
  const encrypted = safeStorage.encryptString(apiKey);
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
