import path from 'node:path';\nexport function resolveRelative(root, value) { return path.resolve(root, value); }
