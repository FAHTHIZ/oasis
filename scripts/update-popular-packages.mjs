#!/usr/bin/env node
// Regenerates src/data/popular-packages.json, the popularity lists the
// typosquatting guard in src/package-vetting.mjs compares install names with.
//   npm:    npm-high-impact (MIT, https://github.com/wooorm/npm-high-impact),
//           most-downloaded first, then most-depended-on
//   PyPI:   top-pypi-packages (https://github.com/hugovk/top-pypi-packages),
//           30-day downloads
//   crates: crates.io API, sorted by all-time downloads
// Usage: node scripts/update-popular-packages.mjs
//
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Download rankings favour transitive dependencies, so names people type into
// install commands (frameworks, CLIs) are seeded in explicitly and always kept
// as targets.
export const SEEDS = {
  npm: ['react', 'react-dom', 'vue', 'angular', 'svelte', 'next', 'express', 'lodash', 'axios', 'moment', 'dayjs', 'chalk', 'commander', 'yargs', 'debug', 'dotenv', 'typescript', 'webpack', 'vite', 'rollup', 'esbuild', 'babel', 'eslint', 'prettier', 'jest', 'mocha', 'vitest', 'chai', 'sinon', 'request', 'node-fetch', 'cross-env', 'rimraf', 'mkdirp', 'glob', 'uuid', 'nanoid', 'zod', 'joi', 'yup', 'ws', 'socket.io', 'mongoose', 'sequelize', 'prisma', 'knex', 'pg', 'mysql', 'mysql2', 'redis', 'ioredis', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'passport', 'cors', 'helmet', 'body-parser', 'multer', 'nodemon', 'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'styled-components', 'redux', 'zustand', 'graphql', 'apollo-server', 'puppeteer', 'playwright', 'cheerio', 'sharp', 'electron', 'fastify', 'koa', 'hono', 'openai', 'colors', 'underscore', 'async', 'bluebird', 'rxjs', 'classnames', 'semver', 'minimist', 'inquirer', 'ora', 'execa', 'fs-extra', 'immer', 'date-fns', 'luxon', 'marked', 'highlight.js', 'three', 'd3', 'chart.js', 'preact', 'got', 'nock', 'jquery', 'chokidar', 'supertest', 'dompurify', 'react-router', 'react-router-dom', 'vue-router', 'pnpm', 'yarn', 'ramda', 'qs', 'ms', 'tsx', 'ts-node', 'tslib', 'undici', 'pino', 'winston', 'morgan'],
  pypi: ['requests', 'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'scikit-learn', 'tensorflow', 'torch', 'keras', 'flask', 'django', 'fastapi', 'uvicorn', 'pydantic', 'sqlalchemy', 'psycopg2', 'pymysql', 'redis', 'celery', 'boto3', 'botocore', 'urllib3', 'certifi', 'idna', 'six', 'setuptools', 'wheel', 'pip', 'pytest', 'tox', 'black', 'flake8', 'pylint', 'mypy', 'isort', 'click', 'typer', 'rich', 'tqdm', 'pyyaml', 'toml', 'jinja2', 'beautifulsoup4', 'lxml', 'selenium', 'scrapy', 'httpx', 'aiohttp', 'pillow', 'opencv-python', 'openai', 'anthropic', 'langchain', 'transformers', 'python-dotenv', 'cryptography', 'paramiko', 'pyjwt', 'jsonschema', 'colorama', 'attrs', 'packaging', 'pytz', 'python-dateutil', 'openpyxl', 'xlrd', 'docker', 'kubernetes', 'gunicorn', 'werkzeug', 'pygame', 'sympy', 'networkx', 'nltk', 'spacy', 'requests-oauthlib', 'types-requests', 'pytest-cov', 'pytest-mock', 'starlette', 'httpcore', 'polars', 'pyarrow', 'streamlit', 'gradio'],
  crates: ['serde', 'serde_json', 'tokio', 'rand', 'clap', 'regex', 'anyhow', 'thiserror', 'log', 'env_logger', 'reqwest', 'hyper', 'axum', 'actix-web', 'chrono', 'itertools', 'lazy_static', 'once_cell', 'futures', 'tracing', 'syn', 'quote', 'bytes', 'uuid', 'sqlx', 'diesel', 'rayon', 'crossbeam', 'ripgrep', 'bat', 'fd-find', 'cargo-edit', 'cargo-watch']
};

// "targets" are the names a lookalike is checked against. "known" are further
// popular names that are trusted as themselves (never reported as a near-miss).
const TARGETS = 3000;
const KNOWN = 10000;
const NPM_SOURCE = 'https://cdn.jsdelivr.net/npm/npm-high-impact@1/lib/';
const PYPI_SOURCE = 'https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json';
const CRATES_SOURCE = 'https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=';
const USER_AGENT = 'oasis-update-popular-packages (https://github.com/FAHTHIZ/oasis)';

async function text(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
  return response.text();
}

// The npm-high-impact modules are `export const x = ['name', ...]`.
const names = (source) => [...source.matchAll(/'((?:[^'\\]|\\.)+)'/g)].map((match) => match[1]);
const unique = (list) => [...new Set(list)];

// Alternates two rankings so neither dominates the target tier.
export function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); }
  return out;
}

export function splitTiers(ranked, seeds = []) {
  const list = unique([...seeds, ...ranked]);
  return { targets: list.slice(0, TARGETS), known: list.slice(TARGETS, KNOWN) };
}

async function main() {
  const npm = splitTiers(interleave(names(await text(NPM_SOURCE + 'top-download.js')), names(await text(NPM_SOURCE + 'top-dependent.js'))), SEEDS.npm);
  const pypi = splitTiers(JSON.parse(await text(PYPI_SOURCE)).rows.map((row) => row.project), SEEDS.pypi);
  const crates = [];
  for (let page = 1; crates.length < TARGETS; page++) {
    const batch = JSON.parse(await text(CRATES_SOURCE + page)).crates || [];
    if (!batch.length) break;
    crates.push(...batch.map((crate) => crate.name));
    await new Promise((resolve) => setTimeout(resolve, 1000)); // crates.io crawler policy: 1 request/second
  }
  const out = {
    sources: { npm: 'npm-high-impact (MIT)', pypi: PYPI_SOURCE, crates: 'https://crates.io/api/v1/crates?sort=downloads' },
    fetchedAt: new Date().toISOString(),
    npm, pypi, crates: splitTiers(crates, SEEDS.crates)
  };
  fs.writeFileSync(new URL('../src/data/popular-packages.json', import.meta.url), JSON.stringify(out) + '\n');
  console.log('npm ' + npm.targets.length + '+' + npm.known.length + ', pypi ' + pypi.targets.length + '+' + pypi.known.length + ', crates ' + out.crates.targets.length);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
