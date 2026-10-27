export function estimateTokens(message) { return Math.ceil(String(message?.content || '').length / 4); }
