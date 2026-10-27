export function parseToolInput(raw) { try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; } }
