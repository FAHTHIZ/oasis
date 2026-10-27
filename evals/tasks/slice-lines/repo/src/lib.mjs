export function sliceLines(text, offset = 1, limit = 2000) { return String(text).split(/\r?\n/).slice(offset, offset + limit).join('\n'); }
