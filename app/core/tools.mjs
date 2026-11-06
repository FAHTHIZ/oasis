// Tools for the universal app. They work on the on-device workspace and never
// touch the host system. Risky actions (deleting, network, pushing) go through
// the approval callback according to the chosen mode.
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

import { relaxedReplace, closestMatchHint } from '../../src/edit-match.mjs';
import { htmlToMarkdown } from '../../src/html-markdown.mjs';

const MAX_RESULT = 24000;

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const TOOL_DEFINITIONS = [
  fn('list_files', 'List project files, optionally under a folder. Returns paths with sizes.', { path: { type: 'string', description: 'Folder inside the project; empty for the root' } }),
  fn('read_file', 'Read a text file with line numbers. Use offset/limit for long files.', { path: { type: 'string' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer', description: 'Number of lines (default 400)' } }, ['path']),
  fn('write_file', 'Create or overwrite a whole file. Prefer edit_file for changes to existing files.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('edit_file', 'Replace an exact snippet in a file. old_string must match once (include surrounding lines to make it unique) unless replace_all is true.', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
  fn('delete_file', 'Delete a file from the project.', { path: { type: 'string' } }, ['path']),
  fn('grep', 'Search file contents. Literal text by default; set regex=true for a regular expression.', { pattern: { type: 'string' }, path: { type: 'string', description: 'Limit to files under this folder or matching this glob' }, regex: { type: 'boolean' }, ignore_case: { type: 'boolean' } }, ['pattern']),
  fn('glob_files', 'Find files by glob, such as src/**/*.ts or *.md.', { pattern: { type: 'string' } }, ['pattern']),
  fn('run_javascript', 'Run JavaScript in an isolated sandbox with no network. Project files are available: require("./path") loads CommonJS modules and JSON, readFile(path) returns text, and a small assert module is built in. console output and the returned value are reported. Use it to run tests and check logic.', { code: { type: 'string' }, timeout_ms: { type: 'integer', description: 'Default 10000, max 60000' } }, ['code']),
  fn('fetch_url', 'Fetch a web page or API over HTTPS and return it as text or Markdown. Some sites block browser apps (CORS).', { url: { type: 'string' } }, ['url']),
  fn('load_skill', 'Load the full instructions of a skill listed in the system prompt. Load only skills that fit the current task.', { name: { type: 'string' } }, ['name']),
  fn('todo_write', 'Keep a short task list for multi-step work. Send the whole list each time.', { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, ['todos']),
  fn('project_changes', 'Show which files changed since the project was imported, with a unified diff for one file if path is given.', { path: { type: 'string' } }),
  fn('github_push', 'Commit the changed files to the project\'s GitHub repository on a branch, and optionally open a pull request. Needs a GitHub token in Settings.', { branch: { type: 'string' }, message: { type: 'string' }, open_pull_request: { type: 'boolean' }, title: { type: 'string' }, body: { type: 'string' } }, ['branch', 'message'])
];

export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.function.name));

/** What each tool needs approval for, by mode: ask | edits | auto. */
export function needsApproval(name, mode) {
  if (mode === 'auto') return name === 'github_push';
  const writes = new Set(['write_file', 'edit_file', 'delete_file']);
  const outside = new Set(['fetch_url', 'github_push']);
  if (mode === 'edits') return outside.has(name) || name === 'delete_file';
  return writes.has(name) || outside.has(name);
}

export function globToRegExp(glob) {
  let source = '';
  const text = String(glob || '').replace(/^\.\//, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '*') {
      if (text[i + 1] === '*') {
        i++;
        if (text[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = text.indexOf('}', i);
      if (end > i) { source += '(?:' + text.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end; } else source += '\\{';
    } else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // A pattern without a slash matches at any depth, like most shells' globstar habits.
  return new RegExp('^' + (text.includes('/') ? '' : '(?:.*/)?') + source + '$');
}

function clip(text, limit = MAX_RESULT) {
  const value = String(text ?? '');
  return value.length > limit ? value.slice(0, limit) + '\n… (' + (value.length - limit) + ' more characters cut; narrow the request)' : value;
}

function unified(path, before, after) {
  return createTwoFilesPatch('a/' + path, 'b/' + path, String(before ?? ''), String(after ?? ''), '', '', { context: 3, headerOptions: FILE_HEADERS_ONLY }).trimEnd();
}

export async function executeTool(name, args, ctx) {
  const ws = ctx.workspace;
  switch (name) {
    case 'list_files': {
      const prefix = String(args.path || '').replace(/^\.?\/+|\/+$/g, '');
      const paths = (await ws.paths()).filter((p) => !prefix || p === prefix || p.startsWith(prefix + '/'));
      if (!paths.length) return prefix ? 'No files under ' + prefix + '.' : 'The project is empty.';
      const files = await ws.load();
      return clip(paths.slice(0, 2000).map((p) => p + '  (' + files.get(p).content.length + ' chars)').join('\n') + (paths.length > 2000 ? '\n… ' + (paths.length - 2000) + ' more' : ''));
    }
    case 'read_file': {
      const text = await ws.read(args.path);
      const lines = text.split('\n');
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((line, i) => String(offset + i).padStart(5) + '  ' + line).join('\n');
      const more = offset - 1 + limit < lines.length ? '\n… lines ' + (offset + limit) + '–' + lines.length + ' not shown; read again with offset.' : '';
      return clip(body + more);
    }
    case 'write_file': {
      const before = (await ws.exists(args.path)) ? await ws.read(args.path) : null;
      const result = await ws.write(args.path, args.content);
      ctx.onChange && ctx.onChange(args.path);
      return (result.created ? 'Created ' : 'Overwrote ') + args.path + ' (' + String(args.content).split('\n').length + ' lines).' + (before !== null && before === args.content ? ' The content was unchanged.' : '');
    }
    case 'edit_file': {
      const current = await ws.read(args.path);
      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');
      if (!oldString) throw new Error('old_string is empty. Use write_file to create a file.');
      if (oldString === newString) throw new Error('old_string and new_string are identical; nothing to change.');
      let next = null;
      const count = current.split(oldString).length - 1;
      if (count === 1 || (count > 1 && args.replace_all)) next = current.split(oldString).join(newString);
      else if (count > 1) throw new Error('old_string matches ' + count + ' places in ' + args.path + '. Include more surrounding lines to make it unique, or set replace_all.');
      else {
        const relaxed = relaxedReplace(current, oldString, newString);
        if (relaxed && typeof relaxed.next === 'string') next = relaxed.next;
      }
      if (next === null) {
        const hint = closestMatchHint(current, oldString);
        throw new Error('old_string was not found in ' + args.path + '. Read the file again and copy the text exactly.' + (hint ? '\n' + hint : ''));
      }
      await ws.write(args.path, next);
      ctx.onChange && ctx.onChange(args.path);
      return 'Edited ' + args.path + '.\n' + clip(unified(args.path, current, next), 4000);
    }
    case 'delete_file': {
      await ws.remove(args.path);
      ctx.onChange && ctx.onChange(args.path);
      return 'Deleted ' + args.path + '.';
    }
    case 'grep': {
      const flags = args.ignore_case ? 'gi' : 'g';
      let matcher;
      try { matcher = new RegExp(args.regex ? String(args.pattern) : String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
      catch (error) { throw new Error('Invalid regular expression: ' + error.message); }
      const scope = String(args.path || '').replace(/^\.?\/+/, '');
      const scopeTest = !scope ? () => true : /[*?{]/.test(scope) ? ((re) => (p) => re.test(p))(globToRegExp(scope)) : (p) => p === scope || p.startsWith(scope.replace(/\/+$/, '') + '/');
      const files = await ws.load();
      const hits = [];
      for (const path of await ws.paths()) {
        if (!scopeTest(path)) continue;
        const lines = files.get(path).content.split('\n');
        for (let i = 0; i < lines.length && hits.length < 400; i++) {
          matcher.lastIndex = 0;
          if (matcher.test(lines[i])) hits.push(path + ':' + (i + 1) + ': ' + lines[i].slice(0, 300));
        }
        if (hits.length >= 400) break;
      }
      return hits.length ? clip(hits.join('\n') + (hits.length >= 400 ? '\n… stopped at 400 matches' : '')) : 'No matches for ' + JSON.stringify(args.pattern) + '.';
    }
    case 'glob_files': {
      const re = globToRegExp(args.pattern);
      const matches = (await ws.paths()).filter((p) => re.test(p));
      return matches.length ? clip(matches.join('\n')) : 'No files match ' + args.pattern + '.';
    }
    case 'run_javascript': {
      if (!ctx.sandbox) throw new Error('JavaScript sandbox is not available here.');
      const files = {};
      for (const path of await ws.paths()) files[path] = (await ws.load()).get(path).content;
      const timeout = Math.min(60000, Math.max(500, Number(args.timeout_ms) || 10000));
      const result = await ctx.sandbox.run(String(args.code || ''), { files, timeoutMs: timeout });
      const parts = [];
      if (result.logs && result.logs.length) parts.push(result.logs.join('\n'));
      if (result.error) parts.push('Error: ' + result.error);
      else if (result.value !== undefined) parts.push('Returned: ' + result.value);
      if (result.timedOut) parts.push('Stopped after ' + timeout + ' ms.');
      return clip(parts.join('\n') || '(no output)');
    }
    case 'fetch_url': {
      let url;
      try { url = new URL(String(args.url)); } catch { throw new Error('Not a valid URL: ' + args.url); }
      if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs can be fetched.');
      const fetchImpl = ctx.fetch || globalThis.fetch.bind(globalThis);
      let response;
      try { response = await fetchImpl(url.href, { signal: ctx.signal, redirect: 'follow' }); }
      catch (error) { throw new Error('Could not fetch ' + url.href + '. The site may block browser apps (CORS) or be offline. ' + error.message); }
      const type = response.headers.get('content-type') || '';
      const text = await response.text();
      let body = text;
      if (/html/.test(type)) {
        const page = htmlToMarkdown(text, { url: url.href });
        body = (page.title ? '# ' + page.title + '\n\n' : '') + page.markdown;
      }
      return 'HTTP ' + response.status + ' ' + url.href + '\n\n' + clip(body, 20000);
    }
    case 'load_skill': {
      if (!ctx.skills) throw new Error('No skills are available.');
      const skill = await ctx.skills.load(String(args.name || ''));
      return '<skill name="' + skill.name + '">\n' + clip(skill.body, 30000) + '\n</skill>';
    }
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos.slice(0, 50).map((item) => ({ content: String(item.content || '').slice(0, 300), status: ['pending', 'in_progress', 'completed'].includes(item.status) ? item.status : 'pending' })) : [];
      ctx.onTodos && ctx.onTodos(todos);
      return todos.map((t) => (t.status === 'completed' ? '[x] ' : t.status === 'in_progress' ? '[>] ' : '[ ] ') + t.content).join('\n') || 'Task list cleared.';
    }
    case 'project_changes': {
      const changes = await ws.changes();
      if (args.path) {
        const file = (await ws.load()).get(String(args.path).replace(/^\.?\/+/, ''));
        if (!file) throw new Error('No such file: ' + args.path);
        return clip(unified(file.path, file.original ?? '', file.deleted ? '' : file.content));
      }
      return changes.length ? changes.map((c) => c.status.padEnd(9) + c.path).join('\n') : 'No changes since import.';
    }
    case 'github_push': {
      if (!ctx.github) throw new Error('Add a GitHub token in Settings and import the project from GitHub before pushing.');
      const result = await ctx.github.push(ws, { branch: args.branch, message: args.message, openPullRequest: Boolean(args.open_pull_request), title: args.title, body: args.body });
      return result.summary;
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
