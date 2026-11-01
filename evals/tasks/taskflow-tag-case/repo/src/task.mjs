import { parseDue } from './dates.mjs';

export const PRIORITIES = ['low', 'normal', 'high'];
export const STATUSES = ['open', 'done'];

export function normalizeTag(tag) {
  const value = String(tag).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw new Error(`Invalid tag: ${tag}`);
  return value;
}

export function createTask(fields, { id, now = new Date() }) {
  const title = String(fields.title || '').trim();
  if (!title) throw new Error('A task needs a title');
  if (title.length > 200) throw new Error('Title is longer than 200 characters');
  const priority = fields.priority || 'normal';
  if (!PRIORITIES.includes(priority)) throw new Error(`Unknown priority: ${priority}`);
  const tags = [...new Set((fields.tags || []).map(normalizeTag))];
  return {
    id,
    title,
    priority,
    status: 'open',
    due: fields.due ? parseDue(fields.due, now) : null,
    tags,
    notes: fields.notes ? String(fields.notes) : '',
    created: now.toISOString()
  };
}

// Returns a new task; the input is never modified.
export function updateTask(task, changes, { now = new Date() } = {}) {
  const next = { ...task, tags: [...task.tags] };
  if (changes.title !== undefined) {
    const title = String(changes.title).trim();
    if (!title) throw new Error('A task needs a title');
    next.title = title;
  }
  if (changes.priority !== undefined) {
    if (!PRIORITIES.includes(changes.priority)) throw new Error(`Unknown priority: ${changes.priority}`);
    next.priority = changes.priority;
  }
  if (changes.status !== undefined) {
    if (!STATUSES.includes(changes.status)) throw new Error(`Unknown status: ${changes.status}`);
    next.status = changes.status;
    if (changes.status === 'done') next.completed = now.toISOString();
    else delete next.completed;
  }
  if (changes.due !== undefined) next.due = changes.due === null ? null : parseDue(changes.due, now);
  if (changes.addTags) for (const tag of changes.addTags.map(normalizeTag)) if (!next.tags.includes(tag)) next.tags.push(tag);
  if (changes.removeTags) {
    const remove = new Set(changes.removeTags.map(normalizeTag));
    next.tags = next.tags.filter((tag) => !remove.has(tag));
  }
  if (changes.notes !== undefined) next.notes = String(changes.notes);
  return next;
}
