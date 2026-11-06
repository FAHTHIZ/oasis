// Streaming filter for command output sent to the model.
//
// It removes only lines that carry nothing a coding agent acts on:
//   - node --test / TAP: the "# Subtest: X" header right before "ok N - X", and
//     the YAML block after a passing test when it holds nothing but
//     duration_ms and type. Failing tests ("not ok") keep everything.
//   - npm's "new version of npm available" banner.
//   - go test -v: "=== RUN   X" immediately followed by "--- PASS: X".
//   - Progress redraws: a line rewritten with carriage returns keeps only its
//     final frame, which is what a terminal would show.
// The raw output still goes to the command log; the caller keeps that log when
// anything was removed and tells the model where it is.
//
// Opt out with OASIS_CONDENSE_OUTPUT=0.

import { StringDecoder } from 'node:string_decoder';

const SUBTEST = /^(\s*)# Subtest: (.*)$/;
const TAP_OK = /^(\s*)ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/;
const YAML_START = /^(\s*)---$/;
const YAML_END = /^\s*\.\.\.$/;
const YAML_TIMING = /^\s*(?:duration_ms: [\d.]+|type: '(?:test|suite)')$/;
const NPM_BARE = /^npm notice\s*$/;
const NPM_UPDATE = /^npm notice (?:New (?:major|minor|patch|prerelease) version of npm available!|Changelog: |To update run: )/;
const GO_RUN = /^(\s*)=== RUN\s+(\S+)$/;
const GO_PASS = /^(\s*)--- PASS: (\S+) \(/;
const MAX_YAML_LINES = 40;
const MAX_RULE_LINE = 4096;
const MAX_PARTIAL = 64 * 1024;


export function condenseOutputEnabled(env = process.env) {
  return !/^(?:0|false|off|no)$/i.test(String(env.OASIS_CONDENSE_OUTPUT || '').trim());
}

/**
 * Returns { push(chunk) -> string, end() -> string, removed, redraws }.
 * push and end return the text to pass on; `removed` counts dropped lines and
 * `redraws` counts lines whose earlier progress frames were dropped.
 */
export function createOutputCondenser() {
  let partial = '';
  let removed = 0;
  let redraws = 0;
  let held = null; // a Subtest header or go RUN line waiting for the next line
  let yaml = null; // lines of a YAML block that follows a passing TAP line
  let okIndent = null; // indentation of the TAP ok line just passed on
  let npmBare = []; // bare "npm notice" lines waiting to see what follows
  let inNpmUpdate = false;
  let out = '';
  const decoder = new StringDecoder('utf8');

  const releaseHeld = () => { if (held) { out += held.line; held = null; } };
  const releaseNpm = () => { out += npmBare.join(''); npmBare = []; };
  const releaseYaml = () => { if (yaml) { out += yaml.join(''); yaml = null; } };
  const releaseAll = () => { releaseNpm(); releaseHeld(); releaseYaml(); okIndent = null; inNpmUpdate = false; };

  // `raw` includes its line terminator, if any.
  function line(raw) {
    const ending = /\r?\n$/.exec(raw);
    const terminator = ending ? ending[0] : '';
    let body = raw.slice(0, raw.length - terminator.length);
    if (body.includes('\r')) {
      const frames = body.split('\r');
      let last = frames.pop();
      while (!last.trim() && frames.length) last = frames.pop();
      if (frames.length) redraws++;
      body = last;
    }
    const text = body + terminator;
    if (body.length > MAX_RULE_LINE) { releaseAll(); out += text; return; }

    if (yaml) {
      yaml.push(text);
      if (YAML_END.test(body)) {
        const inner = yaml.slice(1, -1).map((item) => item.replace(/\r?\n$/, ''));
        if (inner.every((item) => YAML_TIMING.test(item))) { removed += yaml.length; yaml = null; }
        else releaseYaml();
      } else if (yaml.length > MAX_YAML_LINES) releaseYaml();
      return;
    }
    if (okIndent !== null) {
      const start = YAML_START.exec(body);
      const expected = okIndent.length + 2;
      okIndent = null;
      if (start && start[1].length === expected) { yaml = [text]; return; }
    }

    if (NPM_BARE.test(body)) {
      if (inNpmUpdate) removed++;
      else npmBare.push(text);
      return;
    }
    if (NPM_UPDATE.test(body)) {
      removed += npmBare.length + 1;
      npmBare = [];
      inNpmUpdate = true;
      return;
    }
    releaseNpm();
    inNpmUpdate = false;

    if (held) {
      const done = held.kind === 'subtest' ? TAP_OK.exec(body) : GO_PASS.exec(body);
      if (done && done[1] === held.indent && done[2] === held.name) { removed++; held = null; }
      else releaseHeld();
    }
    const subtest = SUBTEST.exec(body);
    if (subtest) { held = { kind: 'subtest', indent: subtest[1], name: subtest[2], line: text }; return; }
    const run = GO_RUN.exec(body);
    if (run) { held = { kind: 'go', indent: run[1], name: run[2], line: text }; return; }
    const ok = TAP_OK.exec(body);
    if (ok) okIndent = ok[1];
    out += text;
  }

  function take() { const text = out; out = ''; return text; }

  return {
    push(chunk) {
      partial += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      let newline = partial.indexOf('\n');
      while (newline >= 0) {
        line(partial.slice(0, newline + 1));
        partial = partial.slice(newline + 1);
        newline = partial.indexOf('\n');
      }
      // A very long unterminated line passes straight through.
      if (partial.length > MAX_PARTIAL) { releaseAll(); out += partial; partial = ''; }
      return take();
    },
    end() {
      partial += decoder.end();
      if (partial) { line(partial); partial = ''; }
      releaseAll();
      return take();
    },
    get removed() { return removed; },
    get redraws() { return redraws; }
  };
}

/** Condense a complete output string. */
export function condenseOutput(text) {
  const condenser = createOutputCondenser();
  const result = condenser.push(String(text || '')) + condenser.end();
  return { text: result, removed: condenser.removed, redraws: condenser.redraws };
}
