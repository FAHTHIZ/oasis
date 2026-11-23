// Flag mistakes that make a command quietly do something other than intended.
// These are notes added to the tool result, never blocks.

// ripgrep: -r is --replace (it rewrites printed matches) and search is already
// recursive, so `rg -rn foo` searches for "foo" and prints every match as "n".
// Only flagged when -r comes before the pattern (rg -rn foo); `rg foo -r bar` is a deliberate replace.
const RG_REPLACE = /(?:^|[|;&(]\s*|\s)rg(?:\.exe)?\s+(?:-[^\s]*\s+)*?-(?!-)[a-zA-Z]*r([a-zA-Z]*)(?=\s|$)/;
// BSD sed (macOS) needs a backup suffix after -i; `sed -i 's/a/b/' f` fails with "invalid command code".
const BSD_SED_INPLACE = /(?:^|[|;&(]\s*|\s)sed\s+(?:-[a-zA-HJ-Z]+\s+)*-i\s+(?:'(?:s|y|\d|\/)|"(?:s|y|\d|\/)|-e\b)/;

export function commandFlagWarning(command, platform = process.platform) {
  const text = String(command || '');
  const notes = [];
  const rg = text.match(RG_REPLACE);
  if (rg) {
    notes.push('Note: in ripgrep, -r means --replace' + (rg[1] ? ' (here it takes "' + rg[1] + '" as the replacement text, so every match prints as that)' : '') +
      ', and rg already searches recursively. If you meant a recursive search, drop -r (for line numbers use -n alone) and run it again.');
  }
  if (platform === 'darwin' && BSD_SED_INPLACE.test(text)) {
    notes.push('Note: macOS sed needs a backup suffix after -i (use sed -i \'\' \'s/a/b/\' file); otherwise it fails with "invalid command code". Prefer edit_file for edits.');
  }
  return notes.join(' ');
}

// run_command runs no shell, so `python3 - <<'PY' ... PY` arrives as literal
// arguments: python reads an empty stdin and exits 0 having done nothing (seen
// live with gpt-oss-20b). Whole-word shell operators in the argument list are
// noted on the result; a lone "|" can be a real grep pattern, so never blocked.
const SHELL_WORDS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '2>', '2>&1', '&>', '|&']);
export function argvShellSyntaxWarning(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const heredoc = list.find((arg) => /^<<-?\s*['"]?[A-Za-z_][\w]*['"]?$/.test(arg));
  const operator = list.find((arg) => SHELL_WORDS.has(arg));
  if (!heredoc && !operator) return '';
  const what = heredoc ? 'the heredoc ' + heredoc : '"' + operator + '"';
  return 'Note: run_command runs no shell, so ' + what + ' was passed to the program as a literal argument' + (heredoc ? ' and no script was fed to it on stdin' : '') + '. If that was not meant, save the code to a file with write_file and run the file, or give one program its own argument list.';
}
