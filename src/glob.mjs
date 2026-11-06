// File-path globs for glob_files and the grep fallback, on picomatch (MIT, no
// dependencies; the matcher behind fast-glob, chokidar and Vite). Dotfiles
// match like any other name, and brackets match either as a character class
// or literally, so Next.js-style paths such as app/[id]/page.tsx still match.
import picomatch from 'picomatch';

/**
 * Compile a glob into a predicate on forward-slash relative paths.
 * basename: patterns without a slash also match the last path component
 * (ripgrep's --glob behaviour).
 */
export function fileGlobMatcher(pattern, { basename = false } = {}) {
  const text = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const options = { dot: true, windows: false, basename: basename && !text.includes('/') };
  const matchers = [picomatch(text, options)];
  if (/[[\]]/.test(text)) matchers.push(picomatch(text, { ...options, literalBrackets: true }));
  return (relative) => matchers.some((match) => match(relative));
}
