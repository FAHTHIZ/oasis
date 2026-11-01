// Task IDs are positive integers. A new ID is one more than the largest ID
// in use, so it never collides with an existing task.
export function nextId(tasks) {
  let max = 0;
  for (const task of tasks) if (task.id > max) max = task.id;
  return max + 1;
}
