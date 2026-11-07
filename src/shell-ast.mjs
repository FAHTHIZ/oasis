// Shell command structure and parser selection.
//
// OASIS uses the typed, synchronous unbash Bash AST by default. Its adapter
// preserves command structure, nested substitutions, static shell wrappers,
// redirections and bounded literal loops. Unknown/dynamic or resource-limited
// cases are reported as incomplete so the risk layer can ask for review.
// Tree-sitter remains an explicit Bash rollback backend and continues to power
// non-shell language intelligence elsewhere. PowerShell/cmd command lines
// remain on their existing parser path.
//
// Set OASIS_SHELL_PARSER=tree-sitter for the retained Bash AST backend, or
// OASIS_SHELL_PARSER=legacy to force the older conservative splitter.

import { loadTreeSitter, loadTreeSitterLanguage } from './tree-sitter.mjs';
import { parseUnbashShellCommands } from './unbash-shell-ast.mjs';

let parser = null;
let loading = null;
let parserMode = process.env.OASIS_SHELL_PARSER === 'tree-sitter' ? 'tree-sitter' : (process.env.OASIS_SHELL_PARSER === 'legacy' ? 'legacy' : 'unbash');

export function shellParserLoaded() {
  return parserMode === 'unbash' || Boolean(parser);
}

export function shellParserMode() {
  return parserMode;
}

export function loadShellParser(env = process.env) {
  if (env.OASIS_SHELL_PARSER === 'legacy') {
    parserMode = 'legacy';
    return Promise.resolve(null);
  }
  if (env.OASIS_SHELL_PARSER !== 'tree-sitter') {
    parserMode = 'unbash';
    return Promise.resolve('unbash');
  }
  parserMode = 'tree-sitter';
  if (!loading) {
    loading = (async () => {
      try {
        const rt = await loadTreeSitter();
        const bash = await loadTreeSitterLanguage('tree-sitter-bash.wasm');
        if (rt && bash) {
          const instance = new rt.Parser();
          instance.setLanguage(bash);
          parser = instance;
        }
      } catch {
        parser = null;
      }
      return parser;
    })();
  }
  return loading;
}

const ANSI_C = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function decodeAnsiC(body) {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs, (all, esc) => {
    const c = esc[0];
    if (c === 'x' || c === 'u' || c === 'U') { try { return String.fromCodePoint(parseInt(esc.slice(1), 16)); } catch { return all; } }
    if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(esc, 8) & 0xff);
    if (c === 'c' && esc.length === 2) return String.fromCharCode(esc.charCodeAt(1) & 0x1f);
    return ANSI_C[c] !== undefined ? ANSI_C[c] : all;
  });
}

const unescapeWord = (text) => text.replace(/\\\n/g, '').replace(/\\(.)/gs, '$1');
const unescapeDouble = (text) => text.replace(/\\\n/g, '').replace(/\\([$`"\\])/g, '$1');

function expansionName(node) {
  if (node.type === 'simple_expansion') return node.text.replace(/^\$/, '');
  if (node.type === 'expansion' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(node.text)) return node.text.slice(2, -1);
  return '';
}

// The word as the shell would see it after quote removal. Expansions stay as
// written ($HOME, ${X}) so the risk rules can recognise them, unless a loop
// binds the name to a literal value.
function wordValue(node, bindings) {
  switch (node.type) {
    case 'word': return unescapeWord(node.text);
    case 'raw_string': return node.text.slice(1, -1);
    case 'ansi_c_string': return decodeAnsiC(node.text.slice(2, -1));
    case 'number': return node.text;
    case 'simple_expansion':
    case 'expansion': {
      const name = expansionName(node);
      return name && bindings.has(name) ? bindings.get(name) : node.text;
    }
    case 'string':
    case 'translated_string': {
      let out = '';
      for (const child of node.children) {
        if (!child.isNamed) { if (child.text !== '"' && child.text !== '$"') out += unescapeDouble(child.text); continue; }
        if (child.type === 'string_content') out += unescapeDouble(child.text);
        else out += wordValue(child, bindings);
      }
      return out;
    }
    case 'concatenation': return node.children.map((child) => (child.isNamed ? wordValue(child, bindings) : unescapeWord(child.text))).join('');
    default: return node.text;
  }
}

const SUBSTITUTIONS = new Set(['command_substitution', 'process_substitution']);

// Commands inside $(...), <(...) and backticks within a word or heredoc.
function walkSubstitutions(node, bindings, out, state) {
  for (const child of node.namedChildren) {
    if (SUBSTITUTIONS.has(child.type)) for (const inner of child.namedChildren) walk(inner, bindings, out, state);
    else walkSubstitutions(child, bindings, out, state);
  }
}

function redirectTokens(node, bindings, cmd, out, state) {
  if (node.type === 'herestring_redirect') {
    const value = node.namedChildren[node.namedChildren.length - 1];
    if (value) { cmd.stdinScript = wordValue(value, bindings); walkSubstitutions(node, bindings, out, state); }
    return ['<<<', cmd.stdinScript || ''];
  }
  if (node.type === 'heredoc_redirect') {
    const tokens = [];
    for (const child of node.namedChildren) {
      if (child.type === 'heredoc_body') { cmd.stdinScript = child.text; walkSubstitutions(child, bindings, out, state); }
      else if (child.type === 'file_redirect' || child.type === 'herestring_redirect') tokens.push(...redirectTokens(child, bindings, cmd, out, state));
    }
    return tokens;
  }
  if (node.type === 'file_redirect') {
    let op = '';
    let destination = '';
    for (const child of node.children) {
      if (child.type === 'file_descriptor') continue;
      if (!child.isNamed) op += child.text;
      else { destination = wordValue(child, bindings); walkSubstitutions(child, bindings, out, state); if (SUBSTITUTIONS.has(child.type)) for (const inner of child.namedChildren) walk(inner, bindings, out, state); }
    }
    return destination ? [op, destination] : [op];
  }
  return [];
}

function buildCommand(node, bindings, redirects, out, state) {
  const cmd = { tokens: [], pipedFrom: null, ast: true };
  out.push(cmd);
  for (const child of node.namedChildren) {
    if (child.type === 'variable_assignment') {
      const value = child.childForFieldName('value');
      cmd.tokens.push(child.childForFieldName('name').text + '=' + (value ? wordValue(value, bindings) : ''));
      if (value) walkSubstitutions(child, bindings, out, state);
      if (value && SUBSTITUTIONS.has(value.type)) for (const inner of value.namedChildren) walk(inner, bindings, out, state);
    } else if (child.type === 'command_name') {
      const name = child.namedChildren[0] || child;
      cmd.tokens.push(wordValue(name, bindings));
      if (name.type === 'command_substitution' || /^\$\(|^`/.test(name.text)) cmd.computedName = true;
      if (SUBSTITUTIONS.has(name.type)) for (const inner of name.namedChildren) walk(inner, bindings, out, state);
      else walkSubstitutions(child, bindings, out, state);
    } else if (/_redirect$/.test(child.type)) {
      cmd.tokens.push(...redirectTokens(child, bindings, cmd, out, state));
    } else if (child.type !== 'comment') {
      cmd.tokens.push(wordValue(child, bindings));
      if (SUBSTITUTIONS.has(child.type)) for (const inner of child.namedChildren) walk(inner, bindings, out, state);
      else walkSubstitutions(child, bindings, out, state);
    }
  }
  for (const redirect of redirects) cmd.tokens.push(...redirectTokens(redirect, bindings, cmd, out, state));
  return cmd;
}

const MAX_LOOP_VALUES = 8;

function walk(node, bindings, out, state) {
  if (++state.nodes > 20000) { state.tooLarge = true; return; }
  switch (node.type) {
    case 'comment': return;
    case 'command': buildCommand(node, bindings, [], out, state); return;
    case 'redirected_statement': {
      const body = node.childForFieldName('body');
      const redirects = node.childrenForFieldName('redirect').filter(Boolean);
      if (body && body.type === 'command') { buildCommand(body, bindings, redirects, out, state); return; }
      if (body) walk(body, bindings, out, state);
      // `{ ...; } > /etc/passwd`: the redirect applies to the whole group.
      const group = { tokens: [':'], pipedFrom: null, ast: true };
      out.push(group);
      for (const redirect of redirects) group.tokens.push(...redirectTokens(redirect, bindings, group, out, state));
      return;
    }
    case 'pipeline': {
      let previous = null;
      for (const stage of node.namedChildren) {
        const start = out.length;
        walk(stage, bindings, out, state);
        if (out.length > start) {
          if (previous && !out[start].pipedFrom) out[start].pipedFrom = previous;
          previous = out[start];
        }
      }
      return;
    }
    case 'variable_assignment': {
      const value = node.childForFieldName('value');
      out.push({ tokens: [node.childForFieldName('name').text + '=' + (value ? wordValue(value, bindings) : '')], pipedFrom: null, ast: true });
      if (value) walkSubstitutions(node, bindings, out, state);
      if (value && SUBSTITUTIONS.has(value.type)) for (const inner of value.namedChildren) walk(inner, bindings, out, state);
      return;
    }
    case 'declaration_command':
    case 'unset_command': {
      const tokens = [node.children[0].text];
      for (const child of node.namedChildren) {
        if (child.type === 'variable_assignment') {
          const value = child.childForFieldName('value');
          tokens.push(child.childForFieldName('name').text + '=' + (value ? wordValue(value, bindings) : ''));
        } else tokens.push(wordValue(child, bindings));
      }
      out.push({ tokens, pipedFrom: null, ast: true });
      walkSubstitutions(node, bindings, out, state);
      return;
    }
    case 'for_statement': {
      const variable = node.childForFieldName('variable');
      const values = node.childrenForFieldName('value').filter(Boolean);
      const body = node.childForFieldName('body');
      for (const value of values) walkSubstitutions(value, bindings, out, state);
      if (!body) return;
      // `for d in ~ /; do rm -rf "$d"; done`: analyse the body once per
      // literal value so the loop variable cannot hide the target.
      const literal = variable && values.length && values.length <= MAX_LOOP_VALUES && values.every((v) => !/\$|`|\*|\?|\[/.test(v.text));
      if (literal) for (const value of values) walk(body, new Map([...bindings, [variable.text, wordValue(value, bindings)]]), out, state);
      else walk(body, bindings, out, state);
      return;
    }
    default:
      if (SUBSTITUTIONS.has(node.type)) { for (const inner of node.namedChildren) walk(inner, bindings, out, state); return; }
      for (const child of node.namedChildren) walk(child, bindings, out, state);
  }
}

// Returns null when the grammar is unavailable, otherwise
// { commands: [{ tokens, pipedFrom, stdinScript?, computedName? }], unparsable, tooLarge }.
// Commands appear in source order and include those inside substitutions,
// functions, conditionals, loops and case arms.
export function parseShellCommands(line) {
  if (parserMode === 'unbash') return parseUnbashShellCommands(line);
  if (parserMode === 'legacy' || !parser) return null;
  const text = String(line || '');
  if (text.length > 100_000) return { commands: [], unparsable: true, tooLarge: true };
  let tree;
  try { tree = parser.parse(text); } catch { return null; }
  try {
    const out = [];
    const state = { nodes: 0, tooLarge: false };
    walk(tree.rootNode, new Map(), out, state);
    return { commands: out.filter((cmd) => cmd.tokens.length), unparsable: tree.rootNode.hasError, tooLarge: state.tooLarge };
  } finally {
    tree.delete();
  }
}
