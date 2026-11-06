// One tree-sitter runtime for the whole process.
//
// The grammars come from @vscode/tree-sitter-wasm (MIT), the build VS Code
// ships: one WebAssembly runtime plus bash, PowerShell and the main
// programming-language grammars, with no native compilation. Parser.init must
// run exactly once per process; concurrent initialisation from two modules
// races and leaves later Language.load calls failing, so every user goes
// through loadTreeSitter().

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

let runtime = null;
let loading = null;
const languages = new Map();

export function loadTreeSitter() {
  if (!loading) {
    loading = (async () => {
      try {
        const require = createRequire(import.meta.url);
        const dir = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
        const mod = require(join(dir, 'tree-sitter.js'));
        await mod.Parser.init({ locateFile: (file) => join(dir, file) });
        runtime = { Parser: mod.Parser, Language: mod.Language, Query: mod.Query, dir };
      } catch {
        runtime = null;
      }
      return runtime;
    })();
  }
  return loading;
}

// Loads a grammar file once (e.g. 'tree-sitter-bash.wasm'); null when the
// runtime or the grammar is unavailable.
export function loadTreeSitterLanguage(file) {
  if (!languages.has(file)) {
    languages.set(file, (async () => {
      const rt = await loadTreeSitter();
      if (!rt || !existsSync(join(rt.dir, file))) return null;
      try { return await rt.Language.load(join(rt.dir, file)); } catch { return null; }
    })());
  }
  return languages.get(file);
}
