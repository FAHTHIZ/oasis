// The installed package version, read once from package.json.
import { readFileSync } from 'node:fs';

let cached = null;
export function oasisVersion() {
  if (cached !== null) return cached;
  try { cached = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || ''); }
  catch { cached = ''; }
  return cached || '0.0.0';
}
