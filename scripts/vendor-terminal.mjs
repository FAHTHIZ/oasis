import { copyFile, mkdir } from 'node:fs/promises';
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
for (const [source, target] of files) {
  await copyFile(path.join(root, source), path.join(destination, target));
}
console.log('OASIS terminal renderer assets are ready.');
