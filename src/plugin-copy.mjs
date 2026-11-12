// Copy a downloaded plugin, marketplace or extension tree into OASIS's plugin
// store. Git repositories and release archives can carry symbolic links; a
// link such as `skills/x/SKILL.md -> ~/.ssh/id_rsa` or `commands/a.md ->
// ~/.aws/credentials` would otherwise be installed as is and read into the
// model's context when the skill or command loads. Links that resolve outside
// the copied tree (or do not resolve) are dropped; `.git` folders are skipped.
import { cp, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

/** cp(from, to) without .git folders or symlinks that point outside `from`. */
export async function copyPluginTree(from, to, { skipGit = true } = {}) {
  const realFrom = await realpath(from);
  await cp(realFrom, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (file) => {
      if (skipGit && path.relative(realFrom, file).split(path.sep).includes('.git')) return false;
      let info;
      try { info = await lstat(file); } catch { return false; }
      if (!info.isSymbolicLink()) return true;
      try { return within(realFrom, await realpath(file)); } catch { return false; }
    }
  });
  return realFrom;
}
