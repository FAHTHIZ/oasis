// Dates are calendar days in local time, stored as YYYY-MM-DD strings.
const DAY_MS = 24 * 60 * 60 * 1000;

export function toDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return next;
}

// Accepts YYYY-MM-DD, "today", "tomorrow" or "+Nd". Returns YYYY-MM-DD or
// throws for anything else.
export function parseDue(input, now = new Date()) {
  const text = String(input).trim().toLowerCase();
  if (text === 'today') return toDay(now);
  if (text === 'tomorrow') return toDay(addDays(now, 1));
  const rel = /^\+(\d{1,3})d$/.exec(text);
  if (rel) return toDay(addDays(now, Number(rel[1])));
  const abs = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (abs) {
    const [y, m, d] = abs.slice(1).map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) return toDay(date);
  }
  throw new Error(`Invalid due date: ${input}`);
}

// A task is overdue only after its due day has ended.
export function isOverdue(task, now = new Date()) {
  if (!task.due || task.status === 'done') return false;
  return task.due < toDay(now);
}

export function daysUntil(due, now = new Date()) {
  const [y, m, d] = due.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY_MS);
}
