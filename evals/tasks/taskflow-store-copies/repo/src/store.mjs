import { readFile, writeFile, rename } from 'node:fs/promises';
import { createEmitter } from './events.mjs';
import { createTask, updateTask } from './task.mjs';
import { nextId } from './ids.mjs';

// The task file holds { version: 1, tasks: [...] }. Writes go to a temporary
// file first and are renamed into place, so a crash never leaves half a file.
export async function openStore(file, { now = () => new Date() } = {}) {
  let tasks = [];
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error(`Unsupported task file: ${file}`);
    tasks = data.tasks;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const events = createEmitter();

  async function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, tasks }, null, 2) + '\n');
    await rename(tmp, file);
  }

  function find(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error(`No task with ID ${id}`);
    return task;
  }

  return {
    events,
    all: () => tasks,
    get: (id) => find(id),
    async add(fields) {
      const task = createTask(fields, { id: nextId(tasks), now: now() });
      tasks = [...tasks, task];
      await save();
      events.emit('added', task);
      return task;
    },
    async update(id, changes) {
      const before = find(id);
      const after = updateTask(before, changes, { now: now() });
      tasks = tasks.map((t) => (t.id === id ? after : t));
      await save();
      if (before.status !== 'done' && after.status === 'done') events.emit('completed', after);
      return after;
    },
    async remove(id) {
      const task = find(id);
      tasks = tasks.filter((t) => t.id !== id);
      await save();
      events.emit('removed', task);
      return task;
    }
  };
}
