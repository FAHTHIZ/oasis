// Where the desktop app keeps the model provider key.
//
// With an OS key store (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet)
// the key is encrypted with Electron safeStorage into secure-secrets.json and
// handed to the runtime as OASIS_API_KEY; config.json keeps only the
// non-secret provider details. Without one (for example Linux with no keyring)
// the key is kept exactly the way the CLI keeps it: in the owner-only (0600)
// config file. The desktop app never refuses to connect for lack of a keyring.
import { loadDesktopApiKey, saveDesktopApiKey, secureStorageAvailable } from './secure-secrets.mjs';

export function createDesktopProviderSecrets({ filePath, safeStorage, env, processEnv = process.env, saveConfig, loadConfig }) {
  const inheritedApiKey = processEnv.OASIS_API_KEY || '';
  const restoreEnvKey = () => {
    if (inheritedApiKey) env.OASIS_API_KEY = inheritedApiKey;
    else delete env.OASIS_API_KEY;
  };

  async function persist(config) {
    const apiKey = (config && config.apiKey) || '';
    if (apiKey && !(await secureStorageAvailable(safeStorage))) {
      await saveConfig({ ...config }, { env });
      // A stale encrypted key must not shadow the one just saved.
      await saveDesktopApiKey('', { filePath, safeStorage }).catch(() => {});
      restoreEnvKey();
      return { storage: 'config-file' };
    }
    const previousSecret = await loadDesktopApiKey({ filePath, safeStorage });
    const previousEnvKey = env.OASIS_API_KEY;
    let secretChanged = false;
    try {
      await saveDesktopApiKey(apiKey, { filePath, safeStorage });
      secretChanged = true;
      if (apiKey) env.OASIS_API_KEY = apiKey;
      else restoreEnvKey();
      // Commit the non-secret details in the same step; the web route does not
      // write config separately when this hook exists.
      await saveConfig({ ...config, apiKey: '' }, { env });
      return { storage: apiKey ? 'os-key-store' : 'none' };
    } catch (error) {
      // A failed config write must not leave a new key paired with the old
      // provider details. Restore the previous encrypted key, best effort.
      if (secretChanged) {
        try { await saveDesktopApiKey(previousSecret || '', { filePath, safeStorage }); } catch {}
      }
      if (previousEnvKey !== undefined) env.OASIS_API_KEY = previousEnvKey;
      else delete env.OASIS_API_KEY;
      throw error;
    }
  }

  async function restore() {
    const saved = await loadDesktopApiKey({ filePath, safeStorage });
    if (saved) { env.OASIS_API_KEY = saved; return { source: 'os-key-store' }; }
    // Move a key from the plaintext config into the key store, but only when
    // it came from the config file (not the user's environment) and the store
    // is available.
    const fromEnvironment = Boolean(processEnv.OASIS_API_KEY || processEnv.OPENAI_API_KEY ||
      processEnv.ANTHROPIC_API_KEY || processEnv.OASIS_LOCAL_API_KEY);
    if (fromEnvironment || !(await secureStorageAvailable(safeStorage))) return { source: fromEnvironment ? 'environment' : 'config-file' };
    try {
      const legacy = await loadConfig({ env });
      if (!legacy.apiKey) return { source: 'none' };
      await saveDesktopApiKey(legacy.apiKey, { filePath, safeStorage });
      env.OASIS_API_KEY = legacy.apiKey;
      await saveConfig({ ...legacy, apiKey: '' }, { env });
      return { source: 'migrated' };
    } catch {
      // Startup stays resilient; the key simply stays where it was.
      return { source: 'config-file' };
    }
  }

  return { persist, restore };
}
