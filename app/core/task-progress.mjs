// Small, deterministic task-progress normalization shared by the browser UI and runtime adapter.
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);

export function normalizeTaskProgress(value) {
  const items = (Array.isArray(value) ? value : []).slice(0, 50)
    .map((item) => ({
      content: String(item && (item.content || item.activeForm || item.title) || '').trim().slice(0, 300),
      status: VALID_STATUSES.has(item && item.status) ? item.status : 'pending',
      ...(item && typeof (item.activeForm || item.active) === 'string' && String(item.activeForm || item.active).trim() ? { active: String(item.activeForm || item.active).replace(/\s+/g, ' ').trim().slice(0, 300) } : {})
    }))
    .filter((item) => item.content);
  const total = items.length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const activeIndex = items.findIndex((item) => item.status === 'in_progress');
  const nextIndex = items.findIndex((item) => item.status === 'pending');
  const activeLabel = activeIndex >= 0 ? (items[activeIndex].active || items[activeIndex].content) : '';
  return { items, total, completed, activeIndex, nextIndex, activeLabel, percent: total ? Math.round(completed / total * 100) : 0, finished: total > 0 && completed === total };
}

export function extractRuntimeTodos(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    const source = value.trim();
    if (!source || (source[0] !== '[' && source[0] !== '{')) return null;
    try { return extractRuntimeTodos(JSON.parse(source), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return normalizeTaskProgress(value).items;
  if (typeof value !== 'object') return null;
  for (const key of ['entries', 'todos', 'result', 'data', 'output']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = extractRuntimeTodos(value[key], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}
