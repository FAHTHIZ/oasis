import { daysUntil, isOverdue } from './dates.mjs';

// Truncates to at most `max` user-visible characters, adding an ellipsis.
export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function relativeDue(task, now = new Date()) {
  if (!task.due) return '';
  if (isOverdue(task, now)) return 'overdue';
  const days = daysUntil(task.due, now);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

const MARK = { low: ' ', normal: '·', high: '!' };

export function formatTask(task, { now = new Date(), width = 40 } = {}) {
  const box = task.status === 'done' ? '[x]' : '[ ]';
  const tags = task.tags.length ? ' ' + task.tags.map((t) => '#' + t).join(' ') : '';
  const due = relativeDue(task, now);
  return `${String(task.id).padStart(3)} ${box} ${MARK[task.priority]} ${truncate(task.title, width)}${tags}${due ? ` (${due})` : ''}`;
}

export function formatList(tasks, options) {
  if (!tasks.length) return 'No tasks.';
  return tasks.map((task) => formatTask(task, options)).join('\n');
}
