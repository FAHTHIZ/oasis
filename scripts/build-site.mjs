#!/usr/bin/env node
// Stage assets used by the public OASIS product website.
// The standalone browser/PWA distribution has been retired; the app UI is
// delivered only by the native desktop host or the connected local runtime.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets', 'demo');
const target = path.join(root, 'site', 'assets', 'demo');
const files = ['oasis-real-model-demo.gif', 'oasis-real-model-demo.mp4', 'oasis-real-model-demo.cast'];

await mkdir(target, { recursive: true });
for (const file of files) await cp(path.join(source, file), path.join(target, file));
console.log('Staged ' + files.length + ' demonstration assets for the OASIS product website.');
