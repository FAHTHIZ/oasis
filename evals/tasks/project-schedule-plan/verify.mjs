import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const ws = process.argv[2];
const spec = JSON.parse(readFileSync(path.join(ws, 'project', 'tasks.json'), 'utf8'));
const plan = JSON.parse(readFileSync(path.join(ws, 'project', 'plan.json'), 'utf8'));
assert.ok(Array.isArray(plan.assignments));
const byTask = new Map(plan.assignments.map((item) => [item.task, item]));
assert.equal(byTask.size, spec.tasks.length, 'one assignment per task');
assert.equal(plan.assignments.length, spec.tasks.length);
const people = new Map(spec.people.map((person) => [person.name, person]));
const busy = new Map();
for (const task of spec.tasks) {
  const item = byTask.get(task.id);
  assert.ok(item, 'assigned: ' + task.id);
  assert.ok(Number.isInteger(item.start) && item.start >= 0, 'integer start: ' + task.id);
  const person = people.get(item.person);
  assert.ok(person && person.skills.includes(task.skill), task.id + ' needs ' + task.skill);
  assert.ok(item.start + task.days <= spec.deadlineDay, task.id + ' finishes by the deadline');
  for (const dep of task.after) {
    const before = spec.tasks.find((other) => other.id === dep);
    assert.ok(byTask.get(dep).start + before.days <= item.start, task.id + ' starts after ' + dep);
  }
  for (let day = item.start; day < item.start + task.days; day++) {
    const key = item.person + ':' + day;
    assert.ok(!busy.has(key), item.person + ' double-booked on day ' + day + ' (' + busy.get(key) + ', ' + task.id + ')');
    busy.set(key, task.id);
  }
}
