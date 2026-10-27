export function isLoopbackUrl(raw) { const value = String(raw || '').toLowerCase(); return value.includes('localhost') || value.includes('127.0.0.1'); }
