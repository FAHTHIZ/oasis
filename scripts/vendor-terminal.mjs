import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'assets', 'vendor');
const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'xterm-addon-fit.js']
];

await mkdir(destination, { recursive: true });
const missing = [];
for (const [source, target] of files) {
  const output = path.join(destination, target);
  try {
    await copyFile(path.join(root, source), output);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    await rm(output, { force: true });
    missing.push(target);
  }
}

if (missing.length) {
  console.warn(
    'OASIS terminal support is optional. Missing renderer files: ' +
    missing.join(', ') +
    '. The Terminal tab will show an installation message.'
  );
} else {
  console.log('OASIS terminal renderer assets are ready.');
}
