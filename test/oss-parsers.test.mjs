// Cases the hand-written parsers got wrong before they were replaced by yaml, smol-toml,
// jsonc-parser, Ajv and jsonrepair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, frontMatterValue, splitFrontMatter } from '../src/frontmatter.mjs';
import { parseJsonc, parseToml, parseYamlSubset } from '../src/importers.mjs';
import { validateJsonSchema } from '../src/json-schema.mjs';
import { repairToolArguments } from '../src/tool-call-repair.mjs';

test('front matter: YAML block scalars, lists and nested maps; scalars stay as written', () => {
  const { data, body } = parseFrontMatter('---\nName: reviewer\ndescription: >\n  Reviews diffs\n  for bugs.\ntools:\n  - Read\n  - Grep\nversion: 1.0\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\nPrompt');
  assert.equal(data.name, 'reviewer');
  assert.equal(data.description, 'Reviews diffs for bugs.');
  assert.deepEqual(data.tools, ['Read', 'Grep']);
  assert.equal(data.version, '1.0');
  assert.deepEqual(data.hooks, { PreToolUse: [{ matcher: 'Bash' }] });
  assert.equal(body, 'Prompt');
});

test('front matter that is not valid YAML still reads like Claude Code reads it', () => {
  const { data } = parseFrontMatter('---\nname: x\ndescription: Use when: the user asks for a review\nglobs: **/*.ts, src/*.js\n---\n');
  assert.equal(data.description, 'Use when: the user asks for a review');
  assert.equal(data.globs, '**/*.ts, src/*.js');
  assert.equal(frontMatterValue('description: "quoted: yes"', 'DESCRIPTION'), 'quoted: yes');
  assert.equal(splitFrontMatter('no front matter').hasFrontMatter, false);
});

test('JSONC keeps strings that contain comment or trailing-comma lookalikes', () => {
  assert.deepEqual(parseJsonc('{ // c\n "url": "http://x//y", "s": ",}", /* b */ "a": [1, 2,], }'), { url: 'http://x//y', s: ',}', a: [1, 2] });
  assert.throws(() => parseJsonc('{"a": }'), /JSONC/);
});

test('TOML 1.0 features: dotted keys, inline tables, arrays of tables, multi-line strings', () => {
  const value = parseToml('a.b = 1\n[[servers]]\nname = "x"\nenv = { K = "v" }\n[[servers]]\nname = """two\nlines"""\n');
  assert.deepEqual(value, { a: { b: 1 }, servers: [{ name: 'x', env: { K: 'v' } }, { name: 'two\nlines' }] });
  assert.throws(() => parseToml('a = [1,'), /TOML: /);
});

test('YAML config: anchors, typed scalars, and errors are reported', () => {
  assert.deepEqual(parseYamlSubset('base: &b\n  enabled: true\nmcp_servers:\n  gh: *b\n'), { base: { enabled: true }, mcp_servers: { gh: { enabled: true } } });
  assert.throws(() => parseYamlSubset('a: [1,\n'));
});

test('JSON Schema: $ref, anyOf, draft-07 tuples and readable paths', () => {
  const schema = { $defs: { n: { type: 'number' } }, type: 'object', properties: { list: { type: 'array', items: { $ref: '#/$defs/n' } }, 'a-b': { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
  assert.deepEqual(validateJsonSchema(schema, { list: [1, 'x'], 'a-b': null }), ['$.list[1]: expected number, got string']);
  assert.deepEqual(validateJsonSchema(schema, { 'a-b': 3 }), ['$["a-b"]: does not match any allowed shape']);
  assert.equal(validateJsonSchema({ $schema: 'http://json-schema.org/draft-07/schema#', items: [{ type: 'string' }], additionalItems: false }, ['a', 2]).length, 1);
  assert.match(validateJsonSchema({ type: 'nonsense' }, 1)[0], /JSON Schema itself is invalid/);
});

test('tool-argument repair: string concatenation and missing commas; truncated strings are refused', () => {
  assert.deepEqual(repairToolArguments('{"a": 1 "b": [1 2]}').args, { a: 1, b: [1, 2] });
  assert.deepEqual(repairToolArguments("{'path': 'a.js', recursive: True}").args, { path: 'a.js', recursive: true });
  assert.throws(() => repairToolArguments('{"path": "a.js", "content": "half a fi'), /not valid JSON/);
});
