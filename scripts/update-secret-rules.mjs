#!/usr/bin/env node
// Regenerates src/data/secret-rules.json, the secret-detection rules the secret
// shield applies to tool output, from Gitleaks' maintained rule set
// (https://github.com/gitleaks/gitleaks, MIT). Usage:
//   node scripts/update-secret-rules.mjs [path/to/gitleaks.toml]
// Without a path it downloads config/gitleaks.toml from the Gitleaks main branch.
//
// Gitleaks regexes use Go RE2 syntax. JavaScript (Node 22) has no inline flag
// groups, so translateGoRegex rewrites (?i), (?i:...), (?-i:...), (?s:...),
// \z, (?P<name>...) and POSIX classes into plain ECMAScript.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';

export const GITLEAKS_RULES_URL = 'https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml';

// Rules that match prose or code rather than credentials. The shield already
// handles KEY=value assignments and credential URLs with tighter patterns, and a
// false positive in tool output hides code from the model.
export const EXCLUDED_RULES = new Set(['generic-api-key']);

const POSIX = { alnum: 'a-zA-Z0-9', alpha: 'a-zA-Z', digit: '0-9', lower: 'a-z', upper: 'A-Z', space: '\\s', xdigit: '0-9a-fA-F', word: '\\w', punct: '!-\\/:-@\\[-`{-~' };

const isLetter = (ch) => /[a-zA-Z]/.test(ch);
const swap = (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());

export function translateGoRegex(source) {
  let i = 0;
  const peek = (n = 0) => source[i + n];

  function readClass(flags) {
    // At '['. Returns an ECMAScript class.
    i++;
    let head = '[';
    if (peek() === '^') { head += '^'; i++; }
    let out = '';
    const extra = [];
    let first = true;
    while (i < source.length && (peek() !== ']' || first)) {
      first = false;
      if (peek() === '[' && peek(1) === ':') {
        const end = source.indexOf(':]', i + 2);
        const name = source.slice(i + 2, end);
        if (!POSIX[name]) throw new Error('Unsupported POSIX class ' + name);
        out += POSIX[name];
        i = end + 2;
        continue;
      }
      let atom;
      if (peek() === '\\') { atom = source.slice(i, i + 2); i += 2; if (atom === '\\x') { atom += source.slice(i, i + 2); i += 2; } }
      else { atom = peek(); i++; }
      if (peek() === '-' && peek(1) !== ']' && peek(1) !== undefined) {
        i++;
        let to;
        if (peek() === '\\') { to = source.slice(i, i + 2); i += 2; if (to === '\\x') { to += source.slice(i, i + 2); i += 2; } }
        else { to = peek(); i++; }
        out += atom + '-' + to;
        if (flags.i && atom.length === 1 && to.length === 1 && isLetter(atom) && isLetter(to) && (atom === atom.toLowerCase()) === (to === to.toLowerCase())) extra.push(swap(atom) + '-' + swap(to));
        continue;
      }
      out += atom;
      if (flags.i && atom.length === 1 && isLetter(atom)) extra.push(swap(atom));
    }
    if (peek() !== ']') throw new Error('Unterminated character class');
    i++;
    // Case-folded additions go first so a trailing literal '-' stays literal.
    return head + extra.join('') + out + ']';
  }

  function readSequence(inherited) {
    const flags = { ...inherited };
    let out = '';
    while (i < source.length && peek() !== ')') {
      const ch = peek();
      if (ch === '\\') {
        const next = peek(1);
        if (next === 'z') { out += '(?![\\s\\S])'; i += 2; }
        else if (next === 'A') { out += '^'; i += 2; }
        else if (next === 'x') { out += source.slice(i, i + 4); i += 4; }
        else { out += source.slice(i, i + 2); i += 2; }
      } else if (ch === '[') {
        out += readClass(flags);
      } else if (ch === '(') {
        i++;
        if (peek() === '?') {
          i++;
          if (peek() === ':') { i++; out += '(?:' + readSequence(flags) + ')'; i++; continue; }
          if (peek() === 'P' && peek(1) === '<') { i++; }
          if (peek() === '<' && peek(1) !== '=' && peek(1) !== '!') {
            const end = source.indexOf('>', i);
            const name = source.slice(i + 1, end);
            i = end + 1;
            out += '(?<' + name + '>' + readSequence(flags) + ')'; i++; continue;
          }
          if (peek() === '=' || peek() === '!' || (peek() === '<' && (peek(1) === '=' || peek(1) === '!'))) {
            const head = peek() === '<' ? source.slice(i, i + 2) : peek();
            i += head.length;
            out += '(?' + head + readSequence(flags) + ')'; i++; continue;
          }
          const match = /^([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(source.slice(i));
          if (!match) throw new Error('Unsupported group at ' + i);
          i += match[0].length;
          const next = { ...flags };
          for (const f of match[1]) next[f] = true;
          for (const f of match[2] || '') next[f] = false;
          for (const f of [...match[1], ...(match[2] || '')]) if (!['i', 's'].includes(f)) throw new Error('Unsupported flag ' + f);
          if (match[3] === ')') { Object.assign(flags, next); continue; }
          out += '(?:' + readSequence(next) + ')'; i++; continue;
        }
        out += '(' + readSequence(flags) + ')';
        i++;
      } else if (ch === '.') {
        out += flags.s ? '[\\s\\S]' : '.'; i++;
      } else if (ch === '{') {
        const end = source.indexOf('}', i);
        out += source.slice(i, end + 1); i = end + 1;
      } else if (isLetter(ch) && flags.i) {
        out += '[' + ch + swap(ch) + ']'; i++;
      } else {
        out += ch; i++;
      }
    }
    return out;
  }

  const out = readSequence({ i: false, s: false });
  if (i < source.length) throw new Error('Unbalanced parenthesis at ' + i);
  new RegExp(out, 'g');
  return out;
}

const lowerList = (list) => (Array.isArray(list) ? list.map((item) => String(item).toLowerCase()) : []);

// Gitleaks builds some rules as [\w.-]{0,50}?(?:[\w.-]{0,50}?<keyword>...). RE2
// runs that in linear time, but a backtracking engine tries up to 2,500 splits
// of the two quantifiers at every position: one 256 KB tool result containing
// "okta" took 550 ms for that rule alone. A single {0,100}? quantifier
// matches exactly the same strings, at the same positions.
const NESTED_LAZY_PREFIX = '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?';
export function flattenNestedLazyPrefix(source) {
  return source.startsWith(NESTED_LAZY_PREFIX) ? '(?:[\\w.-]{0,100}?' + source.slice(NESTED_LAZY_PREFIX.length) : source;
}

export function convertGitleaks(config) {
  const rules = [];
  const skipped = [];
  for (const rule of config.rules || []) {
    if (!rule.regex || EXCLUDED_RULES.has(rule.id)) { skipped.push(rule.id); continue; }
    const entry = { id: rule.id, regex: flattenNestedLazyPrefix(translateGoRegex(rule.regex)) };
    // Rules scoped to file types (e.g. *.tf, nuget.config) run only when the
    // caller knows the text came from a matching path.
    if (rule.path) entry.path = translateGoRegex(rule.path);
    if (rule.secretGroup) entry.secretGroup = rule.secretGroup;
    if (rule.entropy) entry.entropy = rule.entropy;
    if (rule.keywords && rule.keywords.length) entry.keywords = lowerList(rule.keywords);
    const allow = [];
    for (const list of rule.allowlists || []) {
      // Path-only allowlists never apply to tool output, and an AND condition
      // that needs a path match can never be met here.
      if (list.paths && (!list.regexes && !list.stopwords || list.condition === 'AND')) continue;
      const item = {};
      if (list.regexes) item.regexes = list.regexes.map(translateGoRegex);
      if (list.stopwords) item.stopwords = lowerList(list.stopwords);
      if (list.regexTarget) item.target = list.regexTarget;
      if (list.condition === 'AND') item.all = true;
      if (Object.keys(item).length) allow.push(item);
    }
    if (allow.length) entry.allow = allow;
    rules.push(entry);
  }
  const global = config.allowlist || {};
  return {
    rules,
    skipped,
    allow: { regexes: (global.regexes || []).map(translateGoRegex), stopwords: lowerList(global.stopwords) }
  };
}

async function main() {
  const source = process.argv[2];
  const text = source ? fs.readFileSync(source, 'utf8') : await (await fetch(GITLEAKS_RULES_URL)).text();
  const converted = convertGitleaks(parse(text));
  const target = new URL('../src/data/secret-rules.json', import.meta.url);
  fs.writeFileSync(target, JSON.stringify({ source: GITLEAKS_RULES_URL, license: 'MIT (Gitleaks)', fetchedAt: new Date().toISOString(), rules: converted.rules, allow: converted.allow }) + '\n');
  console.log('wrote ' + converted.rules.length + ' rules; skipped ' + converted.skipped.join(', '));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
