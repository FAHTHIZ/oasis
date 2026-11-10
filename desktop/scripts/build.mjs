// Builds the OASIS desktop app from the same runtime the CLI ships.
//
//   node desktop/scripts/build.mjs [--stage-only | --dir] [electron-builder args]
//   e.g. node desktop/scripts/build.mjs --linux AppImage deb --x64
//
// It copies the runtime (src/, app/, assets/, skills/, plugins/, ide/, sw.js)
// and the desktop shell (desktop/*.mjs) into desktop/.stage, writes a
// package.json with the root's exact dependencies and the electron-builder
// configuration, installs production dependencies from the root lockfile, and
// runs electron-builder. Installers land in release/ at the repository root.
// Nothing here forks the runtime: the desktop app is the CLI's web workspace in
// an Electron window, with OS key storage and a checksum-verified updater.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktopDir, '..');
const stage = path.join(desktopDir, '.stage');
const output = path.join(root, 'release');

const RUNTIME_DIRS = ['src', 'app', 'assets', 'skills', 'plugins', 'ide'];
const RUNTIME_FILES = ['sw.js', 'LICENSE', 'README.md', 'package-lock.json'];
// Demo media and README screenshots are not part of the app.
const SKIP = new Set([path.join('assets', 'demo'), path.join('assets', 'screenshots')]);

export function desktopPackageJson(rootPackage, desktopPackage, { outputDir, env = process.env } = {}) {
  // With Apple credentials (CSC_LINK, APPLE_*), electron-builder signs and
  // notarizes. Without them the app is signed ad hoc, which Apple Silicon needs
  // to launch at all; the hardened runtime is off because Electron's frameworks
  // carry Apple's team ID, which an ad-hoc signature cannot match.
  const appleSigning = Boolean(env.CSC_LINK || env.CSC_NAME);
  const electronVersion = String(desktopPackage.devDependencies.electron).replace(/^[^\d]*/, '');
  return {
    // The name and productName decide where Electron keeps app data
    // (~/.config/OASIS, %APPDATA%\OASIS, ~/Library/Application Support/OASIS).
    name: rootPackage.name,
    productName: 'OASIS',
    version: rootPackage.version,
    description: rootPackage.description,
    author: rootPackage.author,
    homepage: rootPackage.homepage,
    license: rootPackage.license,
    repository: rootPackage.repository,
    type: 'module',
    main: 'desktop/main.mjs',
    // Electron's app_id / WM_CLASS, so Linux docks match the window to its launcher.
    desktopName: 'oasis-desktop.desktop',
    dependencies: rootPackage.dependencies,
    optionalDependencies: rootPackage.optionalDependencies,
    // Kept equal to the root so `npm ci` accepts the root lockfile.
    devDependencies: rootPackage.devDependencies,
    overrides: rootPackage.overrides,
    engines: rootPackage.engines,
    oasisRelease: rootPackage.oasisRelease,
    build: {
      appId: 'org.oasis.oss',
      productName: 'OASIS',
      electronVersion,
      directories: { output: outputDir || 'release' },
      files: ['src/**/*', 'desktop/**/*', 'app/**/*', 'sw.js', 'assets/**/*', 'skills/**/*', 'plugins/**/*', 'ide/**/*', 'package.json', 'LICENSE', '!**/node_modules/.bin'],
      artifactName: '${productName}-${version}-${arch}.${ext}',
      asar: true,
      asarUnpack: ['**/node_modules/sharp/**/*', '**/node_modules/@img/**/*', '**/node_modules/node-pty/**/*', '**/node_modules/@vscode/ripgrep/**/*'],
      // Native modules (node-pty, sharp) use N-API, whose ABI is the same in
      // Node and Electron, so the installed binaries load as they are and no
      // C++ toolchain is needed on the build machine.
      npmRebuild: false,
      publish: null,
      mac: {
        target: ['dmg'],
        category: 'public.app-category.developer-tools',
        icon: 'assets/icons/oasis-512.png',
        ...(appleSigning ? {} : { identity: '-', hardenedRuntime: false, notarize: false }),
        extendInfo: { NSMicrophoneUsageDescription: 'OASIS uses the microphone only while you dictate a prompt.' }
      },
      dmg: { writeUpdateInfo: false },
      win: { target: ['nsis'], icon: 'assets/icons/oasis-512.png' },
      nsis: {
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'OASIS',
        // Uninstalling keeps chats, settings and keys unless the user asks.
        deleteAppDataOnUninstall: false,
        differentialPackage: false
      },
      linux: {
        target: ['AppImage', 'deb'],
        category: 'Development',
        icon: 'assets/icons/oasis-512.png',
        executableName: 'oasis-desktop',
        synopsis: 'Open-source AI coding workspace',
        syncDesktopName: true
      },
      deb: { packageName: 'oasis-desktop' },
      icon: 'assets/icons/oasis-512.png'
    }
  };
}

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed with exit code ' + result.status);
}

async function copyRuntime() {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const dir of RUNTIME_DIRS) {
    await cp(path.join(root, dir), path.join(stage, dir), {
      recursive: true,
      filter: (source) => !SKIP.has(path.relative(root, source)) && !source.split(path.sep).includes('node_modules')
    });
  }
  for (const file of RUNTIME_FILES) await cp(path.join(root, file), path.join(stage, file));
  await mkdir(path.join(stage, 'desktop'), { recursive: true });
  for (const entry of await readdir(desktopDir)) {
    if (entry.endsWith('.mjs')) await cp(path.join(desktopDir, entry), path.join(stage, 'desktop', entry));
  }
}

async function main(argv) {
  const stageOnly = argv.includes('--stage-only');
  const builderArgs = argv.filter((arg) => arg !== '--stage-only');
  // The terminal renderer files are produced by the root postinstall.
  if (!(await exists(path.join(root, 'assets', 'vendor', 'xterm.js')))) {
    run(process.execPath, [path.join(root, 'scripts', 'vendor-terminal.mjs')]);
  }
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const desktopPackage = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8'));
  await copyRuntime();
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(desktopPackageJson(rootPackage, desktopPackage, { outputDir: output }), null, 2) + '\n');
  // node-pty builds natively where no prebuilt binary exists (Linux).
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage });
  console.log('Staged the OASIS desktop app in ' + stage);
  if (stageOnly) return;
  const builder = path.join(desktopDir, 'node_modules', 'electron-builder', 'cli.js');
  if (!(await exists(builder))) throw new Error('Run npm ci in desktop/ first to install Electron and electron-builder.');
  run(process.execPath, [builder, '--projectDir', stage, '--publish', 'never', ...builderArgs], { cwd: desktopDir });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error && error.message || error); process.exit(1); });
}
