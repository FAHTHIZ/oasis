import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const NOW = new Date(2026, 10, 1, 15, 30); // Sunday, 1 November 2026, 15:30 local time

export async function tempFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'taskflow-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'tasks.json');
}

export function sink() {
  const out = { text: '', write(chunk) { out.text += chunk; } };
  return out;
}
