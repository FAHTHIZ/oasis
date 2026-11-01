import { isOverdue } from './dates.mjs';
import { PRIORITIES, normalizeTag } from './task.mjs';

export function filterTasks(tasks, { status, tag, priority, overdue, now = new Date() } = {}) {
  const wanted = tag ? normalizeTag(tag) : null;
  return tasks.filter((task) => {
    if (status && status !== 'all' && task.status !== status) return false;
    if (wanted && !task.tags.includes(wanted)) return false;
    if (priority && task.priority !== priority) return false;
    if (overdue && !isOverdue(task, now)) return false;
    return true;
  });
}

const SORTERS = {
  id: (a, b) => a.id - b.id,
  due: (a, b) => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1),
  priority: (a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority),
  title: (a, b) => a.title.localeCompare(b.title)
};

// Stable sort; ties keep ID order.
export function sortTasks(tasks, key = 'id') {
  const compare = SORTERS[key];
  if (!compare) throw new Error(`Unknown sort key: ${key}`);
  return [...tasks].sort((a, b) => compare(a, b) || a.id - b.id);
}

// Pages are numbered from 1.
export function paginate(items, page = 1, size = 20) {
  if (!Number.isInteger(page) || page < 1) throw new Error('Page must be a positive integer');
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('Page size must be between 1 and 100');
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages: Math.max(1, Math.floor(items.length / size)), total: items.length };
}
