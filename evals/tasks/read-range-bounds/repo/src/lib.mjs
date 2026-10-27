export function normalizeReadRange(offset, limit) { return { offset: Number(offset) || 0, limit: Number(limit) || 0 }; }
