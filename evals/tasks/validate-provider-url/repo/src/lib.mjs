export function validateBaseUrl(raw) { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS are supported'); return raw; }
