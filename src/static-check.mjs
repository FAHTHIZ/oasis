// In-process checks for files that have no test runner: HTML, CSS, JSON,
// YAML and TOML. A static page or a config change used to end every turn
// with "Not verified: no test or check command ran", and small models then
// spent a round trip trying to invent a check.
//
// Parsers are the ones OASIS already ships: tree-sitter (JavaScript and CSS
// grammars from @vscode/tree-sitter-wasm) for inline <script>/<style> and
// .css, htmlparser2 for HTML structure and local references, jsonc-parser
// for JSON with comments, yaml and smol-toml. Nothing here runs project code.

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { Parser as HtmlParser } from 'htmlparser2';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { parseAllDocuments } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { loadTreeSitter, loadTreeSitterLanguage } from './tree-sitter.mjs';

export const STATIC_CHECK_EXTENSIONS = new Set(['.html', '.htm', '.css', '.json', '.yaml', '.yml', '.toml']);
const MAX_BYTES = 512 * 1024;
const MAX_PROBLEMS = 12;
const parsers = new Map();

async function treeSitterParser(file) {
  if (!parsers.has(file)) {
    parsers.set(file, (async () => {
      const rt = await loadTreeSitter();
      const language = await loadTreeSitterLanguage(file);
      if (!rt || !language) return null;
      try { const parser = new rt.Parser(); parser.setLanguage(language); return parser; } catch { return null; }
    })());
  }
  return parsers.get(file);
}

// First few ERROR/MISSING nodes as "line N: ..." (1-based, shifted by lineOffset).
async function syntaxProblems(grammarFile, source, label, lineOffset = 0) {
  const parser = await treeSitterParser(grammarFile);
  if (!parser) return [];
  let tree;
  try { tree = parser.parse(source); } catch { return []; }
  try {
    if (!tree.rootNode.hasError) return [];
    const problems = [];
    const visit = (node) => {
      if (problems.length >= 3) return;
      if (node.isMissing) { problems.push(label + ' line ' + (node.startPosition.row + 1 + lineOffset) + ': missing ' + JSON.stringify(node.type)); return; }
      if (node.type === 'ERROR') {
        const snippet = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 40)).split('\n')[0].trim();
        problems.push(label + ' line ' + (node.startPosition.row + 1 + lineOffset) + ': syntax error' + (snippet ? ' near ' + JSON.stringify(snippet) : ''));
        return;
      }
      if (!node.hasError) return;
      for (let i = 0; i < node.childCount; i++) visit(node.child(i));
    };
    visit(tree.rootNode);
    return problems.length ? problems : [label + ': syntax error'];
  } finally {
    tree.delete();
  }
}

const SCRIPT_TYPES = /^(?:|text\/javascript|application\/javascript|module)$/i;

function localReference(value) {
  const ref = String(value || '').trim();
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{|<%)/i.test(ref)) return null;
  const clean = ref.split(/[?#]/)[0];
  if (!clean || clean.startsWith('/')) return null; // site-root paths depend on the server
  try { return decodeURIComponent(clean); } catch { return clean; }
}

async function checkHtml(root, file, text) {
  const problems = [];
  const scripts = [];
  const styles = [];
  const refs = [];
  let current = null;
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const parser = new HtmlParser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      if (tag === 'script') {
        if (attrs.src) refs.push({ attr: 'src', value: attrs.src, line: lineAt(parser.startIndex) });
        else if (SCRIPT_TYPES.test(String(attrs.type || '').trim())) current = { kind: 'script', start: parser.endIndex + 1, module: /module/i.test(attrs.type || '') };
      } else if (tag === 'style') current = { kind: 'style', start: parser.endIndex + 1 };
      else if (tag === 'link' && /\bstylesheet\b|\bicon\b|\bmanifest\b/i.test(attrs.rel || '') && attrs.href) refs.push({ attr: 'href', value: attrs.href, line: lineAt(parser.startIndex) });
      else if (['img', 'source', 'audio', 'video', 'iframe'].includes(tag) && attrs.src) refs.push({ attr: 'src', value: attrs.src, line: lineAt(parser.startIndex) });
      else if (tag === 'a' && attrs.href && /\.html?(?:[?#]|$)/i.test(attrs.href)) refs.push({ attr: 'href', value: attrs.href, line: lineAt(parser.startIndex) });
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (current && (tag === 'script' || tag === 'style') && current.kind === tag) {
        const body = text.slice(current.start, parser.startIndex);
        (tag === 'script' ? scripts : styles).push({ body, line: lineAt(current.start) - 1 });
        current = null;
      }
    }
  }, { decodeEntities: false, lowerCaseTags: true, recognizeSelfClosing: true });
  parser.write(text);
  parser.end();
  if (!/<html[\s>]|<!doctype/i.test(text) && /<(?:head|body)[\s>]/i.test(text)) problems.push(file + ': has <head>/<body> but no <!doctype html> or <html> element');
  for (const [index, script] of scripts.entries()) {
    if (!script.body.trim()) continue;
    problems.push(...await syntaxProblems('tree-sitter-javascript.wasm', script.body, file + ' <script>' + (scripts.length > 1 ? ' #' + (index + 1) : ''), script.line));
  }
  for (const style of styles) {
    if (!style.body.trim()) continue;
    problems.push(...await syntaxProblems('tree-sitter-css.wasm', style.body, file + ' <style>', style.line));
  }
  const base = path.dirname(path.resolve(root, file));
  for (const ref of refs) {
    const local = localReference(ref.value);
    if (!local) continue;
    const target = path.resolve(base, local);
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) continue;
    try { await stat(target); } catch { problems.push(file + ' line ' + ref.line + ': ' + ref.attr + '="' + ref.value + '" points to a file that does not exist'); }
  }
  return problems;
}

function checkJson(file, text) {
  const errors = [];
  // tsconfig, jsconfig, .vscode/*.json and *.jsonc allow comments and trailing commas.
  const lenient = /(?:^|\/)(?:tsconfig[^/]*|jsconfig[^/]*|\.vscode\/[^/]+|[^/]+\.jsonc)\.json$|\.jsonc$/i.test(file) || /(?:^|\/)\.vscode\//.test(file);
  parseJsonc(text, errors, { allowTrailingComma: lenient, disallowComments: !lenient });
  return errors.slice(0, 3).map((error) => file + ' line ' + (text.slice(0, error.offset).split('\n').length) + ': ' + printParseErrorCode(error.error).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
}

function checkYaml(file, text) {
  const problems = [];
  for (const doc of parseAllDocuments(text)) {
    for (const error of doc.errors || []) problems.push(file + (error.linePos && error.linePos[0] ? ' line ' + error.linePos[0].line : '') + ': ' + String(error.message).split('\n')[0]);
  }
  return problems.slice(0, 3);
}

function checkToml(file, text) {
  try { parseToml(text); return []; } catch (error) { return [file + ': ' + String(error.message).split('\n')[0]]; }
}

/**
 * Checks the given workspace-relative files. Returns { checked, problems }:
 * checked lists files a parser looked at; problems are short "file line N:
 * what" strings. Unsupported, missing or huge files are skipped.
 */
export async function staticFileCheck(root, files) {
  const checked = [];
  const problems = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!STATIC_CHECK_EXTENSIONS.has(ext)) continue;
    let text;
    try {
      const absolute = path.resolve(root, file);
      if ((await stat(absolute)).size > MAX_BYTES) continue;
      text = await readFile(absolute, 'utf8');
    } catch { continue; }
    checked.push(file);
    if (ext === '.html' || ext === '.htm') problems.push(...await checkHtml(root, file, text));
    else if (ext === '.css') problems.push(...await syntaxProblems('tree-sitter-css.wasm', text, file));
    else if (ext === '.json') problems.push(...checkJson(file, text));
    else if (ext === '.yaml' || ext === '.yml') problems.push(...checkYaml(file, text));
    else if (ext === '.toml') problems.push(...checkToml(file, text));
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return { checked, problems: problems.slice(0, MAX_PROBLEMS) };
}
