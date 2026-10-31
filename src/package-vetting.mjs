// Package vetting ("slopsquatting" guard). Models sometimes invent package
// names or swap two letters of a popular one; attackers register exactly those
// names. Before install_package runs, the name is looked up on its registry:
//   - not found          -> refused (the name is probably hallucinated)
//   - near-miss of a popular package, brand new, or almost no downloads
//                        -> a human must confirm, even with auto-approve
// Network problems never block an install; they are reported as "unverified".

const POPULAR = {
  npm: ['react', 'react-dom', 'vue', 'angular', 'svelte', 'next', 'express', 'lodash', 'axios', 'moment', 'dayjs', 'chalk', 'commander', 'yargs', 'debug', 'dotenv', 'typescript', 'webpack', 'vite', 'rollup', 'esbuild', 'babel', 'eslint', 'prettier', 'jest', 'mocha', 'vitest', 'chai', 'sinon', 'request', 'node-fetch', 'cross-env', 'rimraf', 'mkdirp', 'glob', 'uuid', 'nanoid', 'zod', 'joi', 'yup', 'ws', 'socket.io', 'mongoose', 'sequelize', 'prisma', 'knex', 'pg', 'mysql', 'mysql2', 'redis', 'ioredis', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'passport', 'cors', 'helmet', 'body-parser', 'multer', 'nodemon', 'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'styled-components', 'redux', 'zustand', 'graphql', 'apollo-server', 'puppeteer', 'playwright', 'cheerio', 'sharp', 'electron', 'fastify', 'koa', 'hono', 'openai', 'colors', 'underscore', 'async', 'bluebird', 'rxjs', 'classnames', 'semver', 'minimist', 'inquirer', 'ora', 'execa', 'fs-extra', 'immer', 'date-fns', 'luxon', 'marked', 'highlight.js', 'three', 'd3', 'chart.js', 'preact', 'got', 'nock', 'jquery', 'chokidar', 'supertest', 'dompurify', 'react-router', 'react-router-dom', 'vue-router', 'pnpm', 'yarn', 'ramda', 'qs', 'ms', 'tsx', 'ts-node', 'tslib', 'undici', 'pino', 'winston', 'morgan'],
  pypi: ['requests', 'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'scikit-learn', 'tensorflow', 'torch', 'keras', 'flask', 'django', 'fastapi', 'uvicorn', 'pydantic', 'sqlalchemy', 'psycopg2', 'pymysql', 'redis', 'celery', 'boto3', 'botocore', 'urllib3', 'certifi', 'idna', 'six', 'setuptools', 'wheel', 'pip', 'pytest', 'tox', 'black', 'flake8', 'pylint', 'mypy', 'isort', 'click', 'typer', 'rich', 'tqdm', 'pyyaml', 'toml', 'jinja2', 'beautifulsoup4', 'lxml', 'selenium', 'scrapy', 'httpx', 'aiohttp', 'pillow', 'opencv-python', 'openai', 'anthropic', 'langchain', 'transformers', 'python-dotenv', 'cryptography', 'paramiko', 'pyjwt', 'jsonschema', 'colorama', 'attrs', 'packaging', 'pytz', 'python-dateutil', 'openpyxl', 'xlrd', 'docker', 'kubernetes', 'gunicorn', 'werkzeug', 'pygame', 'sympy', 'networkx', 'nltk', 'spacy', 'requests-oauthlib', 'types-requests', 'pytest-cov', 'pytest-mock', 'starlette', 'httpcore', 'polars', 'pyarrow', 'streamlit', 'gradio'],
  crates: ['serde', 'serde_json', 'tokio', 'rand', 'clap', 'regex', 'anyhow', 'thiserror', 'log', 'env_logger', 'reqwest', 'hyper', 'axum', 'actix-web', 'chrono', 'itertools', 'lazy_static', 'once_cell', 'futures', 'tracing', 'syn', 'quote', 'bytes', 'uuid', 'sqlx', 'diesel', 'rayon', 'crossbeam', 'ripgrep', 'bat', 'fd-find', 'cargo-edit', 'cargo-watch']
};

// Optimal string alignment distance: insert/delete/substitute/swap-adjacent = 1.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const normalize = (name) => String(name || '').toLowerCase().replace(/[-_.]+/g, '-');

export function nearMiss(registry, name) {
  const target = normalize(name);
  const list = POPULAR[registry] || [];
  if (list.some((item) => normalize(item) === target)) return '';
  for (const item of list) {
    const popular = normalize(item);
    if (popular.length < 4) continue;
    const distance = levenshtein(target, popular);
    if (distance === 1 || (distance === 2 && popular.length >= 8)) return item;
    // Separator or affix games: "python-requests", "requests-py", "react_dom".
    if (target.replace(/-/g, '') === popular.replace(/-/g, '')) return item;
  }
  return '';
}

// Strip version / range so "lodash@4" or "requests>=2" looks up the bare name.
export function bareName(ecosystem, spec) {
  const value = String(spec || '').trim();
  if (ecosystem.startsWith('npm')) {
    const at = value.lastIndexOf('@');
    return at > 0 ? value.slice(0, at) : value;
  }
  if (ecosystem.startsWith('pip')) return value.split(/[<>=!~\[;\s]/)[0];
  return value;
}

export function registryFor(ecosystem) {
  if (ecosystem === 'npm' || ecosystem === 'npm-global') return 'npm';
  if (ecosystem === 'pip' || ecosystem === 'pipx' || ecosystem === 'pipx-fallback') return 'pypi';
  if (ecosystem === 'cargo') return 'crates';
  return '';
}

async function getJson(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'oasis-package-vetting' }, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return { missing: true };
  if (!response.ok) throw new Error('registry returned HTTP ' + response.status);
  return { data: await response.json() };
}

const DAY = 24 * 60 * 60 * 1000;

export async function vetPackage(plan, { fetchImpl = globalThis.fetch, env = process.env, now = Date.now(), timeoutMs = 5000 } = {}) {
  const registry = registryFor(plan && plan.ecosystem);
  if (!registry || /^(0|off|false)$/i.test(String(env.OASIS_PACKAGE_VETTING ?? '')) || typeof fetchImpl !== 'function') return { checked: false, risky: false, warnings: [] };
  const name = bareName(plan.ecosystem, plan.packageName);
  const warnings = [];
  const similar = nearMiss(registry, name);
  if (similar) warnings.push('"' + name + '" is one typo away from the popular package "' + similar + '" — a common typosquatting pattern.');
  let created = null;
  let downloads = null;
  try {
    if (registry === 'npm') {
      const encoded = name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
      const meta = await getJson('https://registry.npmjs.org/' + encoded, fetchImpl, timeoutMs);
      if (meta.missing) return { checked: true, missing: true, risky: true, name, registry, warnings: ['"' + name + '" does not exist on the npm registry.'] };
      created = meta.data && meta.data.time && meta.data.time.created ? Date.parse(meta.data.time.created) : null;
      try {
        const stats = await getJson('https://api.npmjs.org/downloads/point/last-week/' + encoded, fetchImpl, timeoutMs);
        if (stats.data && Number.isFinite(stats.data.downloads)) downloads = stats.data.downloads;
      } catch { /* download stats are optional */ }
    } else if (registry === 'pypi') {
      const meta = await getJson('https://pypi.org/pypi/' + encodeURIComponent(name) + '/json', fetchImpl, timeoutMs);
      if (meta.missing) return { checked: true, missing: true, risky: true, name, registry, warnings: ['"' + name + '" does not exist on PyPI.'] };
      const times = Object.values((meta.data && meta.data.releases) || {}).flat().map((file) => Date.parse(file && (file.upload_time_iso_8601 || file.upload_time))).filter(Number.isFinite);
      created = times.length ? Math.min(...times) : null;
    } else if (registry === 'crates') {
      const meta = await getJson('https://crates.io/api/v1/crates/' + encodeURIComponent(name), fetchImpl, timeoutMs);
      if (meta.missing) return { checked: true, missing: true, risky: true, name, registry, warnings: ['"' + name + '" does not exist on crates.io.'] };
      const crate = meta.data && meta.data.crate;
      created = crate && crate.created_at ? Date.parse(crate.created_at) : null;
      if (crate && Number.isFinite(crate.recent_downloads)) downloads = Math.round(crate.recent_downloads / 13); // ~90 days -> per week
    }
  } catch (error) {
    return { checked: false, risky: Boolean(similar), name, registry, warnings: [...warnings, 'Could not verify "' + name + '" on the registry (' + (error && error.message || error) + ').'] };
  }
  if (created && now - created < 30 * DAY) warnings.push('"' + name + '" was first published ' + Math.max(0, Math.round((now - created) / DAY)) + ' day(s) ago.');
  if (downloads !== null && downloads < 50) warnings.push('"' + name + '" has only ' + downloads + ' download(s) in the last week.');
  return { checked: true, missing: false, risky: warnings.length > 0, name, registry, created, downloads, warnings };
}

// ---- Shell / run_command installs --------------------------------------------
const INSTALLERS = [
  { re: /^(?:npm)$/, subs: ['install', 'i', 'add', 'isntall'], ecosystem: 'npm' },
  { re: /^(?:pnpm|yarn|bun)$/, subs: ['add', 'install', 'i'], ecosystem: 'npm', needsArgs: true },
  { re: /^(?:pip|pip3)$/, subs: ['install'], ecosystem: 'pip' },
  { re: /^(?:uv|poetry|pdm|rye)$/, subs: ['add'], ecosystem: 'pip' },
  { re: /^cargo$/, subs: ['add', 'install'], ecosystem: 'cargo' }
];
const VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--target', '-t', '--prefix', '--root', '--registry', '--features', '--git', '--path', '--branch', '--tag', '--rev', '--version', '--vers', '--group', '-G', '--filter', '-w', '--workspace', '--python']);

function installSpecs(parts) {
  let at = 0;
  while (at < parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[at]) || ['sudo', 'command', 'time', 'nice', 'env', 'npx'].includes(parts[at]))) at++;
  let program = String(parts[at] || '').split('/').pop();
  let rest = parts.slice(at + 1);
  // python -m pip install x
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(program) && rest[0] === '-m' && /^pip\d?$/.test(rest[1] || '')) { program = 'pip'; rest = rest.slice(2); }
  if (program === 'uv' && rest[0] === 'pip') rest = rest.slice(1).map((item, index) => (index === 0 && item === 'install' ? 'add' : item));
  const installer = INSTALLERS.find((item) => item.re.test(program));
  if (!installer) return [];
  const sub = rest.findIndex((item) => !item.startsWith('-'));
  if (sub === -1 || !installer.subs.includes(rest[sub])) return [];
  const specs = [];
  for (let index = sub + 1; index < rest.length; index++) {
    const item = rest[index];
    if (VALUE_FLAGS.has(item)) { index++; continue; }
    if (item.startsWith('-')) continue;
    // Local paths, URLs, git specs, tarballs and requirement files are not registry names.
    if (/^(?:\.|\/|~|[A-Za-z]:\\)|:\/\/|^git\+|^file:|^link:|\.(?:tgz|tar\.gz|whl|zip)$|^github:/.test(item)) continue;
    if (item.includes('/') && !item.startsWith('@')) continue;
    specs.push({ ecosystem: installer.ecosystem, spec: item.replace(/^['"]|['"]$/g, '') });
  }
  return specs;
}

export function extractInstallTargets(command, args) {
  const text = Array.isArray(args) && args.length ? [command, ...args.map(String)].join(' ') : String(command || '');
  const out = [];
  for (const segment of text.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const parts = segment.trim().split(/\s+/).filter(Boolean).map((part) => part.replace(/^['"]|['"]$/g, ''));
    out.push(...installSpecs(parts));
  }
  return out.slice(0, 12);
}

// Vets every registry package a command would install. Returns
// { missing: [...], warnings: [...], risky } — missing names block the command.
export async function vetCommandInstalls(command, args, options = {}) {
  const targets = extractInstallTargets(command, args);
  if (!targets.length) return { targets, missing: [], warnings: [], risky: false };
  const results = await Promise.all(targets.map((target) => vetPackage({ ecosystem: target.ecosystem, packageName: target.spec }, options)));
  const missing = results.filter((result) => result.missing).map((result) => result.name);
  const warnings = results.flatMap((result) => result.warnings || []);
  return { targets, missing, warnings, risky: results.some((result) => result.risky), results };
}

// Shared guard for run_command / run_shell. Returns { blocked } with a tool
// result when a named package does not exist, or { approvalNote, forceAsk }.
export async function guardInstallCommand(command, args, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (/^(0|off|false)$/i.test(String(env.OASIS_PACKAGE_VETTING ?? ''))) return {};
  const vetting = await vetCommandInstalls(command, args, { env, fetchImpl });
  if (!vetting.targets.length) return {};
  if (vetting.missing.length) {
    return { blocked: { approved: false, blocked: true, vetting: { missing: vetting.missing, warnings: vetting.warnings }, message: vetting.warnings.filter((item) => /does not exist/.test(item)).join(' ') + ' The command was not run. The name may be misspelled or invented; check the exact package name before trying again.' } };
  }
  if (!vetting.warnings.length) return {};
  return { approvalNote: 'Package check: ' + vetting.warnings.join(' '), forceAsk: vetting.risky, warnings: vetting.warnings };
}
