/**
 * Detect a model service running on this computer without accepting a URL from
 * the caller. The endpoint is intentionally fixed to Ollama's loopback API.
 */
export async function discoverLocalOllamaModels({ fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  try {
    const response = await fetchImpl('http://127.0.0.1:11434/api/tags', {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(100, Math.min(5000, Number(timeoutMs) || 1500))),
      headers: { accept: 'application/json' }
    });
    if (!response || !response.ok) {
      return {
        available: false,
        models: [],
        message: 'Ollama was not found or is not running. Install it from ollama.com/download, open it, and check again.'
      };
    }
    const payload = await response.json();
    const models = Array.isArray(payload && payload.models)
      ? [...new Set(payload.models
          .map((item) => String(item && (item.name || item.model) || '').trim())
          .filter(Boolean))]
          .slice(0, 100)
      : [];
    return {
      available: true,
      models,
      message: models.length
        ? 'Ollama is running. Choose an installed model, then test the connection.'
        : 'Ollama is running, but no models are installed yet. Install one from the Ollama app or terminal, then check again.'
    };
  } catch {
    return {
      available: false,
      models: [],
      message: 'Ollama was not found or is not running. Install it from ollama.com/download, open it, and check again.'
    };
  }
}
