// Code structure from real grammars (tree-sitter), for the repo map.
//
// Aider, Roo Code, Cline and OpenCode find definitions with tree-sitter; the
// regex line patterns OASIS used miss multi-line and indented forms, count
// nested helper functions as API, and treat words in comments and strings as
// symbol uses. This module uses the grammars bundled in
// @vscode/tree-sitter-wasm (MIT) for the languages it ships and returns null
// for anything else, so callers keep their regex fallback.

import { loadTreeSitter, loadTreeSitterLanguage } from './tree-sitter.mjs';

// Repo-map language key -> grammar file. C files parse well with the C++
// grammar, which the bundle ships (there is no separate C grammar).
const GRAMMARS = {
  js: 'tree-sitter-javascript.wasm',
  ts: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  py: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rs: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  cs: 'tree-sitter-c-sharp.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  rb: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
  sh: 'tree-sitter-bash.wasm'
};

const EXTENSION_GRAMMAR = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.py': 'py', '.pyi': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.cs': 'cs',
  '.c': 'cpp', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.rb': 'rb', '.php': 'php', '.sh': 'sh', '.bash': 'sh'
};

const JS_DEFS = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (_) @name) @def
(method_definition name: (_) @name) @def
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (class)]) @def
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @def))
`;
const TS_EXTRA = `
(abstract_class_declaration name: (_) @name) @def
(interface_declaration name: (_) @name) @def
(type_alias_declaration name: (_) @name) @def
(enum_declaration name: (_) @name) @def
(function_signature name: (identifier) @name) @def
(abstract_method_signature name: (_) @name) @def
(internal_module name: (_) @name) @def
`;

const QUERIES = {
  js: JS_DEFS,
  ts: JS_DEFS + TS_EXTRA,
  tsx: JS_DEFS + TS_EXTRA,
  py: `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`,
  go: `
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_spec name: (type_identifier) @name) @def
`,
  rs: `
(function_item name: (identifier) @name) @def
(function_signature_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
(type_item name: (type_identifier) @name) @def
(mod_item name: (identifier) @name) @def
(macro_definition name: (identifier) @name) @def
(impl_item type: (type_identifier) @name) @def
`,
  java: `
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(record_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
`,
  cs: `
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(struct_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(record_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
`,
  cpp: `
(function_definition declarator: (function_declarator declarator: [(identifier) (field_identifier)] @name)) @def
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @def
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def
(struct_specifier name: (type_identifier) @name body: (_)) @def
(class_specifier name: (type_identifier) @name body: (_)) @def
(enum_specifier name: (type_identifier) @name body: (_)) @def
(union_specifier name: (type_identifier) @name body: (_)) @def
(namespace_definition name: (namespace_identifier) @name) @def
(type_definition declarator: (type_identifier) @name) @def
`,
  rb: `
(method name: (_) @name) @def
(singleton_method name: (_) @name) @def
(class name: (_) @name) @def
(module name: (_) @name) @def
`,
  php: `
(function_definition name: (name) @name) @def
(class_declaration name: (name) @name) @def
(interface_declaration name: (name) @name) @def
(trait_declaration name: (name) @name) @def
(enum_declaration name: (name) @name) @def
(method_declaration name: (name) @name) @def
`,
  sh: `
(function_definition name: (word) @name) @def
`
};

// Definitions inside these are local helpers, not part of a file's API.
const FUNCTION_SCOPES = new Set([
  'function_declaration', 'generator_function_declaration', 'function_expression', 'arrow_function', 'method_definition',
  'function_definition', 'function_item', 'method_declaration', 'constructor_declaration', 'method', 'singleton_method',
  'lambda', 'closure_expression', 'func_literal', 'local_function_statement', 'anonymous_function'
]);

const NOISE = /comment|^string|string$|^template_string$|heredoc_body|raw_string_literal|interpreted_string_literal|char_literal|regex/;

const languages = new Map();

export function grammarForFile(file) {
  const match = /\.[^./\\]+$/.exec(String(file));
  return match ? EXTENSION_GRAMMAR[match[0].toLowerCase()] || null : null;
}

// Loads (once) the parser and definition query for a grammar key; null when
// the grammar is unavailable, disabled, or its query does not compile.
export async function loadCodeGrammar(key, env = process.env) {
  if (!key || !GRAMMARS[key] || env.OASIS_REPO_MAP_PARSER === 'regex') return null;
  if (languages.has(key)) return languages.get(key);
  const pending = (async () => {
    const rt = await loadTreeSitter();
    const language = await loadTreeSitterLanguage(GRAMMARS[key]);
    if (!rt || !language) return null;
    try {
      const parser = new rt.Parser();
      parser.setLanguage(language);
      // Comments and string literals, found natively by one query instead of
      // walking every node across the WebAssembly boundary.
      const noiseTypes = new Set();
      for (let id = 0; id < language.nodeTypeCount; id++) {
        const type = language.nodeTypeForId(id);
        if (type && language.nodeTypeIsNamed(id) && language.nodeTypeIsVisible(id) && NOISE.test(type)) noiseTypes.add(type);
      }
      let noise = null;
      if (noiseTypes.size) { try { noise = new rt.Query(language, '[' + [...noiseTypes].map((type) => '(' + type + ')').join(' ') + '] @noise'); } catch { noise = null; } }
      return { parser, query: new rt.Query(language, QUERIES[key]), noise };
    } catch {
      return null;
    }
  })();
  languages.set(key, pending);
  const loaded = await pending;
  languages.set(key, loaded);
  return loaded;
}

function insideFunction(node) {
  for (let up = node.parent; up; up = up.parent) if (FUNCTION_SCOPES.has(up.type)) return true;
  return false;
}

function isMember(node) {
  for (let up = node.parent; up && up.parent; up = up.parent) {
    if (/class_body|class_declaration|class_definition|class_specifier|struct_specifier|declaration_list|impl_item|trait_item|interface_body|enum_body|^class$|^module$|field_declaration_list|object_type/.test(up.type)) return true;
  }
  return false;
}

// Returns { defs, masked } or null. defs match the repo map's shape
// ({ name, line, signature, member }); masked is the source with comments and
// string literals blanked (same length and line breaks), for counting real
// identifier uses.
export function analyzeCode(grammar, text, options = {}) {
  if (!grammar) return null;
  const source = String(text);
  let tree;
  try { tree = grammar.parser.parse(source); } catch { return null; }
  try {
    const lines = source.split('\n');
    const maxDefs = options.maxDefs || 400;
    const defs = [];
    const seen = new Set();
    for (const match of grammar.query.matches(tree.rootNode)) {
      if (defs.length >= maxDefs) break;
      const def = match.captures.find((c) => c.name === 'def');
      const name = match.captures.find((c) => c.name === 'name');
      if (!def || !name) continue;
      const nameText = name.node.text;
      if (!nameText || nameText.length < 2 || insideFunction(def.node)) continue;
      const row = def.node.startPosition.row;
      const key = nameText + ':' + row;
      if (seen.has(key)) continue;
      seen.add(key);
      let signature = (lines[row] || '').trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ');
      if (signature.length > 140) signature = signature.slice(0, 137) + '...';
      defs.push({ name: nameText, line: row + 1, signature, member: isMember(def.node) });
    }
    defs.sort((a, b) => a.line - b.line);
    let masked = null;
    if (options.mask !== false && grammar.noise) {
      // Outermost noise ranges in source order, blanked except line breaks so
      // offsets and line numbers stay the same.
      const ranges = grammar.noise.captures(tree.rootNode).map((c) => [c.node.startIndex, c.node.endIndex]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let out = '';
      let at = 0;
      for (const [start, end] of ranges) {
        if (end <= at) continue;
        const from = Math.max(start, at);
        out += source.slice(at, from) + source.slice(from, end).replace(/[^\n]/g, ' ');
        at = end;
      }
      masked = out + source.slice(at);
    }
    return { defs, masked };
  } finally {
    tree.delete();
  }
}
