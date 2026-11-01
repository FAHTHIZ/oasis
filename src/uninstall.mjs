import path from 'node:path';

const PACKAGE_NAME = 'oasis-oss';

/**
 * Calculate the only supported uninstall target: the OASIS package inside a
 * global npm prefix. This is deliberately a pure function so path-safety rules
 * can be regression-tested without invoking npm or changing the machine.
 */
export function resolveUninstallPlan(appRoot, installedPackage) {
  const applicationRoot = path.resolve(String(appRoot || ''));
  const nodeModules = path.dirname(applicationRoot);
  if (path.basename(nodeModules) !== 'node_modules') {
    throw new Error('This OASIS copy does not look like a global npm installation. I will not delete project files. Remove it with the package manager used to install it.');
  }
  const packageName = String(installedPackage && installedPackage.name || '');
  if (packageName !== PACKAGE_NAME) {
    throw new Error('The installed package name was not oasis-oss. Nothing was removed.');
  }
  if (path.basename(applicationRoot) !== PACKAGE_NAME) {
    throw new Error('The OASIS package directory does not match its installed package name. Nothing was removed.');
  }
  const libOrPrefix = path.dirname(nodeModules);
  const prefix = path.resolve(path.basename(libOrPrefix) === 'lib' ? path.dirname(libOrPrefix) : libOrPrefix);
  if (!prefix || prefix === path.parse(prefix).root) {
    throw new Error('The detected npm prefix is not a safe user installation directory. Nothing was removed.');
  }
  return {
    packageName: PACKAGE_NAME,
    prefix,
    applicationRoot,
    args: ['uninstall', '--global', '--prefix', prefix, PACKAGE_NAME]
  };
}
