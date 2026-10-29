import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { loadDesktopApiKey, saveDesktopApiKey } from '../desktop/secure-secrets.mjs';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'oasis-desktop-secrets-test-'));
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) { return Buffer.from('fixture-encrypted:' + value, 'utf8'); },
    decryptString(value) {
      const raw = value.toString('utf8');
      if (!raw.startsWith('fixture-encrypted:')) throw new Error('Invalid fixture ciphertext');
      return raw.slice('fixture-encrypted:'.length);
    }
  };
}

test('desktop API keys are encrypted before being written and round-trip through safeStorage', async (t) => {
  const root = await tempDir();
  const filePath = path.join(root, 'secure-secrets.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const secret = 'test-key-never-store-in-plaintext';
  const safeStorage = fakeSafeStorage();
  assert.deepEqual(await saveDesktopApiKey(secret, { filePath, safeStorage }), { saved: true });

  const stored = await readFile(filePath, 'utf8');
  assert.equal(stored.includes(secret), false, 'the key must not be stored as plaintext');
  assert.equal(JSON.parse(stored).version, 1);
  assert.equal(await loadDesktopApiKey({ filePath, safeStorage }), secret);
});

test('desktop API key removal deletes its protected file', async (t) => {
  const root = await tempDir();
  const filePath = path.join(root, 'secure-secrets.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const safeStorage = fakeSafeStorage();

  await saveDesktopApiKey('temporary-key', { filePath, safeStorage });
  assert.deepEqual(await saveDesktopApiKey('', { filePath, safeStorage }), { saved: false });
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
  assert.equal(await loadDesktopApiKey({ filePath, safeStorage }), '');
});

test('desktop storage fails closed when the operating-system store is unavailable', async (t) => {
  const root = await tempDir();
  const filePath = path.join(root, 'secure-secrets.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    saveDesktopApiKey('must-not-be-written', { filePath, safeStorage: fakeSafeStorage(false) }),
    /secure storage is unavailable/i
  );
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
  assert.equal(await loadDesktopApiKey({ filePath, safeStorage: fakeSafeStorage(false) }), '');
});

test('desktop storage rejects invalid keys and oversized or malformed secret files', async (t) => {
  const root = await tempDir();
  const filePath = path.join(root, 'secure-secrets.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const safeStorage = fakeSafeStorage();

  await assert.rejects(saveDesktopApiKey('bad\nkey', { filePath, safeStorage }), /invalid or too long/i);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, 'x'.repeat(17 * 1024), 'utf8'));
  assert.equal(await loadDesktopApiKey({ filePath, safeStorage }), '');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, '{"version":2,"encryptedApiKey":"eA=="}', 'utf8'));
  assert.equal(await loadDesktopApiKey({ filePath, safeStorage }), '');
});
