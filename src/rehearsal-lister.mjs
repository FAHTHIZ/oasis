// Runs inside the rehearsal sandbox (see rehearsal.mjs): starts the command,
// waits for it, then lists the merged contents of every directory present in
// the overlay's upper layer, so the host can tell which lower entries an
// opaque (replaced) directory dropped without reading overlay xattrs.
//
// argv: upper lower reportFile -- command args...
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [upper, lower, report, separator, command, ...args] = process.argv.slice(2);
if (separator !== '--' || !command) process.exit(2);
const child = spawn(command, args, { stdio: 'inherit' });
const forward = (signal) => { try { child.kill(signal); } catch {} };
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('error', (error) => { process.stderr.write(String(error.message || error) + '\n'); finish(127); });
child.on('exit', (code, signal) => finish(code === null ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code));

let done = false;
function finish(exitCode) {
  if (done) return;
  done = true;
  const dirs = {};
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(rel ? path.join(upper, rel) : upper, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      try { dirs[childRel] = readdirSync(path.join(lower, childRel)); } catch {}
      walk(childRel);
    }
  };
  walk('');
  try { writeFileSync(report, JSON.stringify({ exitCode, dirs })); } catch {}
  process.exit(exitCode);
}
