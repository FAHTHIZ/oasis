// Names of branches OASIS creates for isolated worktrees: PREFIX + slug, where
// PREFIX is "oasis/" or a team convention such as "feature/" or "fh-".

export function normalizeBranchPrefix(value) {
  const prefix = String(value || '').trim();
  if (!prefix || prefix.length > 40) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*[/_-]$/.test(prefix) || /\.\.|\/\/|\/\.|\.\/|@\{|\.lock\//.test(prefix)) return null;
  return prefix;
}

/** True for a branch name that could have come from createWorktree (any valid prefix). */
export function isWorktreeBranchName(value) {
  const branch = String(value || '');
  if (branch.length > 140) return false;
  const match = /^(.*?[/_-])([a-z0-9][a-z0-9-]{0,99})$/i.exec(branch);
  if (!match) return false;
  for (let cut = match[1].length; cut < branch.length; cut += 1) {
    if (normalizeBranchPrefix(branch.slice(0, cut)) && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(branch.slice(cut))) return true;
  }
  return false;
}
