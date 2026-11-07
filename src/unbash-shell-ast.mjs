import { forEachChild, parse as parseBash } from 'unbash';

const DYNAMIC_PARTS = new Set([
  'SimpleExpansion',
  'ParameterExpansion',
  'CommandExpansion',
  'ArithmeticExpansion',
  'ProcessSubstitution',
  'BraceExpansion',
  'ExtendedGlob',
  'Glob'
]);
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const MAX_SOURCE_CHARS = 100_000;
const MAX_NODES = 20_000;
const MAX_LOOP_VALUES = 8;
const MAX_WRAPPER_DEPTH = 4;

function basename(value) {
  return String(value || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

function partValue(part, bindings) {
  if (!part) return '';
  const type = part.type;
  if (type === 'SimpleExpansion') {
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(part.text || '');
    return match && bindings.has(match[1]) ? bindings.get(match[1]) : part.text;
  }
  if (type === 'ParameterExpansion') {
    const simple = part.operation === undefined && part.index === undefined && !part.prefix;
    return simple && bindings.has(part.parameter) ? bindings.get(part.parameter) : part.text;
  }
  if (type === 'DoubleQuoted' || type === 'LocaleString') {
    return (part.parts || []).map((child) => partValue(child, bindings)).join('');
  }
  if (type === 'SingleQuoted' || type === 'AnsiCQuoted' || type === 'Literal') {
    return part.value ?? part.text ?? '';
  }
  if (type === 'Glob' || type === 'BraceExpansion' || type === 'ExtendedGlob') {
    return part.value ?? part.text ?? '';
  }
  return part.value ?? part.text ?? '';
}

function wordValue(word, bindings = new Map()) {
  if (!word) return '';
  if (!bindings.size || !Array.isArray(word.parts)) return word.value ?? word.text ?? '';
  return word.parts.map((part) => partValue(part, bindings)).join('');
}

function hasDynamicParts(parts, depth = 0) {
  if (!Array.isArray(parts) || depth > 24) return false;
  for (const part of parts) {
    if (DYNAMIC_PARTS.has(part.type)) return true;
    if (hasDynamicParts(part.parts, depth + 1)) return true;
    if (part.operand?.parts && hasDynamicParts(part.operand.parts, depth + 1)) return true;
  }
  return false;
}

function isDynamicWord(word) {
  return Boolean(word && hasDynamicParts(word.parts));
}

function assignmentToken(assignment, bindings) {
  const value = assignment.value;
  let rendered = '';
  if (value?.type === 'ArrayValue') {
    rendered = '(' + (value.elements || []).map((item) => wordValue(item, bindings)).join(' ') + ')';
  } else {
    rendered = wordValue(value, bindings);
  }
  return String(assignment.name || '') + (assignment.append ? '+=' : '=') + rendered;
}

function addRedirect(redirect, command, bindings) {
  if (!redirect) return [];
  if (redirect.type === 'HereDoc') {
    command.stdinScript = redirect.body?.text ?? '';
    return [];
  }
  if (redirect.type === 'HereString') {
    const script = wordValue(redirect.target, bindings);
    command.stdinScript = script;
    return [redirect.operator, script];
  }
  if (redirect.type === 'Redirect') {
    const target = redirect.target ? wordValue(redirect.target, bindings) : '';
    return target ? [redirect.operator, target] : [redirect.operator];
  }
  return [];
}

function buildCommand(node, bindings) {
  const command = { tokens: [], pipedFrom: null, ast: true };
  for (const item of node.prefix || []) {
    if (item.type === 'Assignment') command.tokens.push(assignmentToken(item, bindings));
    else command.tokens.push(...addRedirect(item, command, bindings));
  }
  if (node.name) {
    command.tokens.push(wordValue(node.name, bindings));
    if (isDynamicWord(node.name)) command.computedName = true;
  }
  for (const item of node.suffix || []) {
    if (item.type === 'Assignment') command.tokens.push(assignmentToken(item, bindings));
    else if (item.type === 'Redirect' || item.type === 'HereString' || item.type === 'HereDoc') {
      command.tokens.push(...addRedirect(item, command, bindings));
    } else {
      command.tokens.push(wordValue(item, bindings));
    }
  }
  return command;
}

const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']);
const SHELL_OPTIONS_NO_VALUE = new Set([
  '--login', '--noediting', '--noprofile', '--norc', '--posix', '--restricted',
  '--verbose', '--version', '--help', '--debugger', '--dump-po-strings', '--dump-strings'
]);

function commandBody(words, bindings) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const value = wordValue(word, bindings);
    if (isDynamicWord(word)) return null;
    if (value === '--') continue;
    if (SHELL_OPTIONS_WITH_VALUE.has(value)) {
      // An option value is not a command string. Do not mistake it for the
      // argument to a later -c option (e.g. --rcfile config -c 'git push').
      if (!words[i + 1] || isDynamicWord(words[i + 1])) return null;
      i++;
      continue;
    }
    if (value.startsWith('--')) {
      if (/^--(?:rcfile|init-file)=/.test(value) || SHELL_OPTIONS_NO_VALUE.has(value)) continue;
      // Unknown long options may consume another word. Stop rather than guess.
      return null;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(value)) {
      const scriptWord = words[i + 1];
      if (!scriptWord || isDynamicWord(scriptWord)) return null;
      return wordValue(scriptWord, bindings);
    }
    if (/^[+-][a-zA-Z]+$/.test(value)) continue;
    // A positional word before -c means the wrapper shape is not one we can
    // safely interpret as a static shell invocation.
    return null;
  }
  return null;
}

function nestedWrapperSource(node, bindings) {
  if (!node.name || isDynamicWord(node.name)) return null;
  const name = basename(wordValue(node.name, bindings));
  const words = (node.suffix || []).filter((item) => item.type === 'Word');
  if (SHELLS.has(name)) return commandBody(words, bindings);
  if (name !== 'env') return null;
  let shellIndex = -1;
  for (let i = 0; i < words.length; i++) {
    const value = wordValue(words[i], bindings);
    if (value === '--') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
    if (value.startsWith('-')) continue;
    if (SHELLS.has(basename(value)) && !isDynamicWord(words[i])) {
      shellIndex = i;
      break;
    }
    return null;
  }
  return shellIndex < 0 ? null : commandBody(words.slice(shellIndex + 1), bindings);
}

function visitChildren(node, out, state, bindings, wrapperDepth) {
  forEachChild(node, (child) => {
    if (state.tooLarge) return;
    // An Assignment belonging to a Command is metadata, not a separate command.
    if (child.type === 'Assignment') {
      visitChildren(child, out, state, bindings, wrapperDepth);
      return;
    }
    walk(child, out, state, bindings, wrapperDepth);
  });
}

function walk(node, out, state, bindings = new Map(), wrapperDepth = 0) {
  if (!node || state.tooLarge) return { first: null, last: null, primary: null };
  if (++state.nodes > MAX_NODES) {
    state.tooLarge = true;
    return { first: null, last: null, primary: null };
  }
  if (Array.isArray(node.errors) && node.errors.length) state.unparsable = true;

  if (node.type === 'Command') {
    const command = buildCommand(node, bindings);
    if (command.tokens.length) out.push(command);
    visitChildren(node, out, state, bindings, wrapperDepth);
    const source = nestedWrapperSource(node, bindings);
    if (source) {
      if (wrapperDepth >= MAX_WRAPPER_DEPTH) state.tooLarge = true;
      else parseNested(source, out, state, bindings, wrapperDepth + 1);
    }
    return { first: command.tokens.length ? command : null, last: command.tokens.length ? command : null, primary: command.tokens.length ? command : null };
  }

  if (node.type === 'Pipeline') {
    let first = null;
    let previous = null;
    let last = null;
    for (const stage of node.commands || []) {
      const result = walk(stage, out, state, bindings, wrapperDepth);
      if (!result.first) continue;
      if (previous) result.first.pipedFrom = previous;
      if (!first) first = result.first;
      previous = result.primary || result.last || result.first;
      last = result.last || result.first;
      if (state.tooLarge) break;
    }
    return { first, last, primary: first || last };
  }

  if (node.type === 'For') {
    const words = node.wordlist || [];
    const body = node.body;
    for (const word of words) {
      if (isDynamicWord(word)) walk(word, out, state, bindings, wrapperDepth);
    }
    if (!body) return { first: null, last: null, primary: null };
    const canExpand = node.name && words.length > 0 && words.length <= MAX_LOOP_VALUES
      && words.every((word) => !isDynamicWord(word));
    if (canExpand) {
      let first = null;
      let last = null;
      for (const word of words) {
        const scoped = new Map(bindings);
        scoped.set(node.name.value, wordValue(word, bindings));
        const result = walk(body, out, state, scoped, wrapperDepth);
        if (!first && result.first) first = result.first;
        if (result.last) last = result.last;
        if (state.tooLarge) break;
      }
      return { first, last, primary: first || last };
    }
    // A command in a dynamic, globbed or oversized loop may receive a
    // destructive target through the loop variable. Analyse its visible body
    // for specific denials, but tell callers this is not a complete parse so
    // shell-risk keeps the request behind an explicit approval.
    state.unparsable = true;
    return walk(body, out, state, bindings, wrapperDepth);
  }

  if (node.type === 'Redirected') {
    const before = out.length;
    const result = walk(node.command, out, state, bindings, wrapperDepth);
    const group = { tokens: [':'], pipedFrom: null, ast: true };
    for (const redirect of node.redirects || []) group.tokens.push(...addRedirect(redirect, group, bindings));
    if (group.tokens.length > 1 || out.length === before) out.push(group);
    return {
      first: result.first || (group.tokens.length > 1 ? group : null),
      last: group.tokens.length > 1 ? group : (result.last || result.first),
      primary: result.primary || result.first || group
    };
  }

  if (node.type === 'Assignment') {
    const command = { tokens: [assignmentToken(node, bindings)], pipedFrom: null, ast: true };
    out.push(command);
    visitChildren(node, out, state, bindings, wrapperDepth);
    return { first: command, last: command, primary: command };
  }

  let first = null;
  let last = null;
  forEachChild(node, (child) => {
    const result = walk(child, out, state, bindings, wrapperDepth);
    if (!first && result.first) first = result.first;
    if (result.last) last = result.last;
  });
  return { first, last, primary: first || last };
}

function parseNested(source, out, state, bindings, wrapperDepth) {
  try {
    const nested = parseBash(source);
    walk(nested, out, state, bindings, wrapperDepth);
  } catch {
    state.unparsable = true;
  }
}

function inspectErrors(node, state) {
  if (!node || state.tooLarge) return;
  if (Array.isArray(node.errors) && node.errors.length) state.unparsable = true;
  if (++state.nodes > MAX_NODES) {
    state.tooLarge = true;
    return;
  }
  forEachChild(node, (child) => inspectErrors(child, state));
}

export function parseUnbashShellCommands(input) {
  const text = String(input || '');
  if (text.length > MAX_SOURCE_CHARS) {
    return { commands: [], unparsable: true, tooLarge: true };
  }
  const state = { nodes: 0, unparsable: false, tooLarge: false };
  const commands = [];
  try {
    const ast = parseBash(text);
    inspectErrors(ast, state);
    if (!state.tooLarge) {
      state.nodes = 0;
      walk(ast, commands, state);
    }
  } catch {
    state.unparsable = true;
  }
  return {
    commands: commands.filter((command) => Array.isArray(command.tokens) && command.tokens.length),
    unparsable: state.unparsable,
    tooLarge: state.tooLarge
  };
}
