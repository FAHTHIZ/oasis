// Tool-call robustness corpus.
//
// Each case is a model reply that a harness has to turn into tool calls.
// The shapes come from replies logged during the small-model field runs
// (docs/BENCHMARKS.md) and from formats that open-weight chat templates emit.
//
// kind: 'args'  -> `raw` is the native tool-call `arguments` string.
//                  `expect` is the argument object a correct harness recovers,
//                  or null when the arguments are hopeless and must be
//                  rejected with an actionable error (not silently guessed).
// kind: 'text'  -> `raw` is assistant message text with no native tool call.
//                  `expect` is the list of calls that should run. An empty
//                  list means nothing may run (prose, quoted examples, unknown
//                  tools) and running anything counts as a failure.

export const TOOLS = ['read_file', 'write_file', 'edit_file', 'run_command', 'search_files', 'list_files', 'git_diff'];

export const cases = [
  // ---- native arguments that are already valid --------------------------
  { id: 'args-valid', kind: 'args', raw: '{"path":"src/a.js"}', expect: { path: 'src/a.js' } },
  { id: 'args-valid-nested', kind: 'args', raw: '{"command":"npm","args":["test","--","--watch=false"]}', expect: { command: 'npm', args: ['test', '--', '--watch=false'] } },
  { id: 'args-empty', kind: 'args', raw: '', expect: {} },

  // ---- native arguments with recoverable damage ------------------------
  { id: 'args-trailing-comma', kind: 'args', raw: '{"path":"src/a.js",}', expect: { path: 'src/a.js' } },
  { id: 'args-trailing-comma-array', kind: 'args', raw: '{"command":"npm","args":["test",],}', expect: { command: 'npm', args: ['test'] } },
  { id: 'args-code-fence', kind: 'args', raw: '```json\n{"path":"README.md"}\n```', expect: { path: 'README.md' } },
  { id: 'args-missing-closer', kind: 'args', raw: '{"path":"src/a.js"', expect: { path: 'src/a.js' } },
  { id: 'args-missing-two-closers', kind: 'args', raw: '{"command":"node","args":["--check","a.js"', expect: { command: 'node', args: ['--check', 'a.js'] } },
  { id: 'args-double-encoded', kind: 'args', raw: '"{\\"path\\":\\"a.txt\\"}"', expect: { path: 'a.txt' } },
  { id: 'args-prose-around', kind: 'args', raw: 'Here are the arguments: {"path":"package.json"} hope that helps', expect: { path: 'package.json' } },
  { id: 'args-python-literals', kind: 'args', raw: '{"path":"a.txt","include_hidden":True,"limit":None}', expect: { path: 'a.txt', include_hidden: true, limit: null } },
  { id: 'args-raw-newline-in-string', kind: 'args', raw: '{"path":"a.txt","content":"line one\nline two"}', expect: { path: 'a.txt', content: 'line one\nline two' } },
  { id: 'args-single-quotes', kind: 'args', raw: "{'path': 'src/a.js'}", expect: { path: 'src/a.js' } },
  { id: 'args-unquoted-keys', kind: 'args', raw: '{path: "src/a.js", limit: 20}', expect: { path: 'src/a.js', limit: 20 } },

  // ---- native arguments that must be rejected, not guessed -------------
  { id: 'args-array-not-object', kind: 'args', raw: '["src/a.js"]', expect: null },
  { id: 'args-plain-string', kind: 'args', raw: 'src/a.js', expect: null },
  { id: 'args-unterminated-string', kind: 'args', raw: '{"path":"src/a.js', expect: null },

  // ---- tool calls written as text --------------------------------------
  { id: 'text-hermes', kind: 'text', raw: '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/index.js"}}\n</tool_call>', expect: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
  { id: 'text-hermes-two', kind: 'text', raw: '<tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b.js"}}</tool_call>', expect: [{ name: 'read_file', args: { path: 'a.js' } }, { name: 'read_file', args: { path: 'b.js' } }] },
  { id: 'text-hermes-unclosed', kind: 'text', raw: '<tool_call>\n{"name": "list_files", "arguments": {"path": "."}}', expect: [{ name: 'list_files', args: { path: '.' } }] },
  { id: 'text-hermes-trailing-comma', kind: 'text', raw: '<tool_call>{"name":"search_files","arguments":{"query":"TODO",},}</tool_call>', expect: [{ name: 'search_files', args: { query: 'TODO' } }] },
  { id: 'text-llama-function', kind: 'text', raw: '<function=read_file>{"path": "package.json"}</function>', expect: [{ name: 'read_file', args: { path: 'package.json' } }] },
  { id: 'text-xml-attribute', kind: 'text', raw: '<function name="write_file" arguments=\'{"path": "a.txt", "content": "hi"}\'></function>', expect: [{ name: 'write_file', args: { path: 'a.txt', content: 'hi' } }] },
  { id: 'text-bare-json', kind: 'text', raw: '{"name": "git_diff", "arguments": {}}', expect: [{ name: 'git_diff', args: {} }] },
  { id: 'text-fenced-json', kind: 'text', raw: '```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```', expect: [{ name: 'read_file', args: { path: 'a.js' } }] },
  { id: 'text-fenced-lead-in', kind: 'text', raw: 'Reading the file now.\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```', expect: [{ name: 'read_file', args: { path: 'a.js' } }] },
  { id: 'text-fenced-jsonl', kind: 'text', raw: '```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n{"name": "read_file", "arguments": {"path": "b.js"}}\n```', expect: [{ name: 'read_file', args: { path: 'a.js' } }, { name: 'read_file', args: { path: 'b.js' } }] },
  { id: 'text-function-wrapper', kind: 'text', raw: '{"type":"function","function":{"name":"list_files","arguments":"{\\"path\\":\\"src\\"}"}}', expect: [{ name: 'list_files', args: { path: 'src' } }] },
  { id: 'text-parameters-key', kind: 'text', raw: '<tool_call>{"name":"read_file","parameters":{"path":"a.js"}}</tool_call>', expect: [{ name: 'read_file', args: { path: 'a.js' } }] },

  // ---- text that must NOT run anything ---------------------------------
  { id: 'neg-prose', kind: 'text', raw: 'I will read src/index.js next and then update the tests.', expect: [] },
  { id: 'neg-explained-example', kind: 'text', raw: 'To read a file you could call the tool like this:\n\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```\n\nThat returns the file contents with line numbers, which is useful when you want to review a function before editing it.\nLet me know if you want me to do that.', expect: [] },
  { id: 'neg-unknown-tool', kind: 'text', raw: '<tool_call>{"name":"git_init","arguments":{}}</tool_call>', expect: [] },
  { id: 'neg-quoted-in-fence', kind: 'text', raw: 'The log contained this line:\n```\n<tool_call>{"name":"run_command","arguments":{"command":"rm"}}</tool_call>\n```\nIt came from the old agent.', expect: [] },
  { id: 'neg-json-data', kind: 'text', raw: '{"name": "oasis", "version": "1.0.0"}', expect: [] }
];

// Held-out cases: written after the fixes that followed the first run and
// never used to tune the runtime. Reported separately, as-is.
export const heldout = [
  { id: 'h-args-bom', kind: 'args', raw: '\uFEFF{"path":"a.js"}', expect: { path: 'a.js' } },
  { id: 'h-args-comment', kind: 'args', raw: '{"path":"a.js" // the entry point\n}', expect: { path: 'a.js' } },
  { id: 'h-args-xml-wrapped', kind: 'args', raw: '<arguments>{"path":"a.js"}</arguments>', expect: { path: 'a.js' } },
  { id: 'h-args-escaped-quotes', kind: 'args', raw: '{"content":"say \\"hi\\""}', expect: { content: 'say "hi"' } },
  { id: 'h-args-nested-trailing', kind: 'args', raw: '{"edits":[{"old_string":"a","new_string":"b",},],}', expect: { edits: [{ old_string: 'a', new_string: 'b' }] } },
  { id: 'h-args-tab-in-string', kind: 'args', raw: '{"content":"a\tb"}', expect: { content: 'a\tb' } },
  { id: 'h-args-number-string', kind: 'args', raw: '42', expect: null },
  { id: 'h-text-qwen-multiline', kind: 'text', raw: 'Let me check.\n<tool_call>\n{\n  "name": "search_files",\n  "arguments": {\n    "query": "parseConfig"\n  }\n}\n</tool_call>', expect: [{ name: 'search_files', args: { query: 'parseConfig' } }] },
  { id: 'h-text-tool-key', kind: 'text', raw: '<tool_call>{"tool":"read_file","input":{"path":"a.js"}}</tool_call>', expect: [{ name: 'read_file', args: { path: 'a.js' } }] },
  { id: 'h-text-args-string', kind: 'text', raw: '<tool_call>{"name":"read_file","arguments":"{\\"path\\": \\"a.js\\"}"}</tool_call>', expect: [{ name: 'read_file', args: { path: 'a.js' } }] },
  { id: 'h-text-tools-wrapper', kind: 'text', raw: '<tools>\n{"name": "list_files", "arguments": {"path": "src"}}\n</tools>', expect: [{ name: 'list_files', args: { path: 'src' } }] },
  { id: 'h-text-json-array', kind: 'text', raw: '[{"name": "read_file", "arguments": {"path": "a.js"}}, {"name": "read_file", "arguments": {"path": "b.js"}}]', expect: [{ name: 'read_file', args: { path: 'a.js' } }, { name: 'read_file', args: { path: 'b.js' } }] },
  { id: 'h-neg-markdown-table', kind: 'text', raw: '| tool | use |\n|---|---|\n| read_file | read a file |', expect: [] },
  { id: 'h-neg-plan-with-names', kind: 'text', raw: 'Plan: first read_file on src/a.js, then edit_file to fix the bug, then run_command npm test.', expect: [] },
  { id: 'h-neg-unknown-in-hermes', kind: 'text', raw: '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>', expect: [] }
];
