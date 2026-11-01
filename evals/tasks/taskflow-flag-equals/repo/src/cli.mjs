#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { filterTasks, sortTasks, paginate } from './query.mjs';
import { formatList } from './format.mjs';

const VALUE_FLAGS = new Set(['priority', 'due', 'tag', 'status', 'sort', 'page', 'size', 'notes', 'file']);
const BOOLEAN_FLAGS = new Set(['overdue', 'help']);

// Supports --flag value and boolean --flag. "--" ends options.
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const tags = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === 'tag') tags.push(value);
    else flags[name] = value;
  }
  if (tags.length) flags.tags = tags;
  return { command: positional[0], args: positional.slice(1), flags };
}

function parseId(text) {
  if (!/^[1-9]\d*$/.test(String(text))) throw new Error(`Invalid task ID: ${text}`);
  return Number(text);
}

export async function run(argv, { stdout = process.stdout, env = process.env, now } = {}) {
  const { command, args, flags } = parseArgs(argv);
  const file = flags.file || env.TASKFLOW_FILE || path.join(os.homedir(), '.taskflow.json');
  const store = await openStore(file, now ? { now } : {});
  const print = (text) => stdout.write(text + '\n');
  const clock = now ? now() : new Date();
  switch (command) {
    case 'add': {
      const task = await store.add({ title: args.join(' '), priority: flags.priority, due: flags.due, tags: flags.tags, notes: flags.notes });
      print(`Added task ${task.id}.`);
      return 0;
    }
    case 'list': {
      const filtered = filterTasks(store.all(), { status: flags.status || 'open', tag: flags.tags && flags.tags[0], priority: flags.priority, overdue: flags.overdue, now: clock });
      const sorted = sortTasks(filtered, flags.sort || 'id');
      const page = paginate(sorted, flags.page ? Number(flags.page) : 1, flags.size ? Number(flags.size) : 20);
      print(formatList(page.items, { now: clock }));
      if (page.pages > 1) print(`Page ${page.page} of ${page.pages} (${page.total} tasks)`);
      return 0;
    }
    case 'done': {
      for (const id of args.map(parseId)) await store.update(id, { status: 'done' });
      print(`Completed ${args.length} task(s).`);
      return 0;
    }
    case 'reopen': {
      for (const id of args.map(parseId)) await store.update(id, { status: 'open' });
      print(`Reopened ${args.length} task(s).`);
      return 0;
    }
    case 'tag': {
      const [id, ...tagList] = args;
      await store.update(parseId(id), { addTags: tagList });
      print(`Tagged task ${id}.`);
      return 0;
    }
    case 'rm': {
      for (const id of args.map(parseId)) await store.remove(id);
      print(`Removed ${args.length} task(s).`);
      return 0;
    }
    default:
      print('Usage: taskflow <add|list|done|reopen|tag|rm> [options]');
      return command ? 2 : 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`taskflow: ${error.message}\n`);
    process.exitCode = 1;
  });
}
