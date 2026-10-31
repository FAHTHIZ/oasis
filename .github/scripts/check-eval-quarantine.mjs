#!/usr/bin/env node
// This check keeps benchmark questions out of training and teacher data.
// It deliberately has no model calls and never prints the question text.

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');

// Ignore generated or dependency folders. They are not project-authored datasets.
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'release', 'eval-results'
]);

// Any directory with one of these names is protected from benchmark-question leakage.
const PROTECTED_DIRECTORY_NAMES = new Set([
  'train', 'training', 'training-data', 'model-training',
  'snapshots', 'snapshot',
  'teacher-dialogue', 'teacher-dialogues', 'teacher-data'
]);

// Only known text formats are accepted under protected directories.
// An unfamiliar extension is a hard failure because this script cannot inspect it safely.
const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.js', '.mjs',
  '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.svg', '.webmanifest',
  '.sh', '.py', '.sql', '.patch', '.diff', '.lock', '.gitignore'
]);

const ALLOWED_EXTENSIONLESS_NAMES = new Set([
  'LICENSE', 'NOTICE', 'README', 'CONTRIBUTING', '.gitkeep', '.gitignore'
]);

const MAX_TEXT_FILE_BYTES = 15 * 1024 * 1024;

function normalizeDirectoryName(name) {
  // Treat spaces and underscores as hyphens so common folder-name variants match.
  return name.normalize('NFC').toLowerCase().replace(/[ _]+/g, '-');
}

function normalizePrompt(text) {
  // Normalize line endings and whitespace but keep the actual words and punctuation.
  return String(text).normalize('NFC').replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

function collectStringValues(value, output = []) {
  // Walk nested JSON data so prompts inside message arrays are checked too.
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, output);
  }
  return output;
}

function isAllowedTextFile(filePath) {
  const baseName = path.basename(filePath);
  const extension = path.extname(baseName).toLowerCase();
  if (extension) return ALLOWED_TEXT_EXTENSIONS.has(extension);
  return ALLOWED_EXTENSIONLESS_NAMES.has(baseName);
}

async function addPrompt(prompts, errors, sourcePath, rawText) {
  const normalized = normalizePrompt(rawText);
  if (!normalized) {
    errors.push(sourcePath + ': benchmark prompt is empty.');
    return;
  }
  prompts.push({
    id: sourcePath,
    text: normalized
  });
}

async function collectLegacyTaskPrompts(rootDir, prompts, errors) {
  const tasksRoot = path.join(rootDir, 'evals', 'tasks');
  let entries;
  try {
    entries = await readdir(tasksRoot, { withFileTypes: true });
  } catch (error) {
    errors.push('Could not read evals/tasks: ' + error.message);
    return;
  }

  for (const entry of entries) {
    if (entry.name === 'metadata.json') continue;
    const taskDir = path.join(tasksRoot, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(path.relative(rootDir, taskDir) + ': symbolic links are not allowed.');
      continue;
    }
    if (!entry.isDirectory()) {
      errors.push(path.relative(rootDir, taskDir) + ': unexpected file in evals/tasks.');
      continue;
    }

    const promptPath = path.join(taskDir, 'task.md');
    try {
      const info = await lstat(promptPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        errors.push(path.relative(rootDir, promptPath) + ': task prompt must be a regular file.');
        continue;
      }
      if (info.size > MAX_TEXT_FILE_BYTES) {
        errors.push(path.relative(rootDir, promptPath) + ': task prompt exceeds the scan size limit.');
        continue;
      }
      await addPrompt(prompts, errors, path.relative(rootDir, promptPath), await readFile(promptPath, 'utf8'));
    } catch (error) {
      errors.push(path.relative(rootDir, promptPath) + ': could not read task prompt: ' + error.message);
    }
  }
}

async function collectFrozenJsonlPrompts(rootDir, prompts, errors) {
  const tasksRoot = path.join(rootDir, 'bench', 'tasks');
  let rootInfo;
  try {
    rootInfo = await lstat(tasksRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    errors.push('Could not inspect bench/tasks: ' + error.message);
    return;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    errors.push('bench/tasks must be a regular directory.');
    return;
  }

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(path.relative(rootDir, directory) + ': could not read directory: ' + error.message);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (entry.isSymbolicLink()) {
        errors.push(relativePath + ': symbolic links are not allowed in frozen tasks.');
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let raw;
        try {
          const info = await lstat(fullPath);
          if (info.size > MAX_TEXT_FILE_BYTES) throw new Error('file exceeds the scan size limit');
          raw = await readFile(fullPath, 'utf8');
        } catch (error) {
          errors.push(relativePath + ': could not read frozen task file: ' + error.message);
          continue;
        }

        const lines = raw.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index].trim();
          if (!line) continue;
          try {
            const record = JSON.parse(line);
            if (!record || typeof record !== 'object' || Array.isArray(record) ||
                typeof record.prompt !== 'string' || !record.prompt.trim()) {
              throw new Error('each JSONL record must contain a non-empty string field named prompt');
            }
            await addPrompt(prompts, errors, relativePath + ':' + (index + 1), record.prompt);
          } catch (error) {
            errors.push(relativePath + ':' + (index + 1) + ': invalid frozen task record: ' + error.message);
          }
        }
      } else {
        errors.push(relativePath + ': only .jsonl files are allowed in bench/tasks.');
      }
    }
  }

  await walk(tasksRoot);
}

async function discoverProtectedDirectories(rootDir, errors) {
  const protectedDirectories = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(path.relative(rootDir, directory) + ': could not inspect directory: ' + error.message);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isSymbolicLink()) {
        // Fail on repository symlinks instead of accidentally scanning through an alias.
        errors.push(relativePath + ': symbolic links are not allowed by the quarantine check.');
        continue;
      }

      if (!entry.isDirectory() || IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;

      const normalizedName = normalizeDirectoryName(entry.name);
      if (PROTECTED_DIRECTORY_NAMES.has(normalizedName)) {
        protectedDirectories.push({
          path: fullPath,
          relativePath,
          kind: normalizedName === 'snapshots' || normalizedName === 'snapshot'
            ? 'snapshot'
            : 'training'
        });
      }

      await walk(fullPath);
    }
  }

  await walk(rootDir);
  return protectedDirectories;
}

function extractSearchableText(fileText, extension, relativePath, errors) {
  // JSON and JSONL need parsing so escaped newlines and nested messages are checked.
  if (extension === '.json') {
    try {
      return collectStringValues(JSON.parse(fileText));
    } catch (error) {
      errors.push(relativePath + ': invalid JSON in a protected directory: ' + error.message);
      return [];
    }
  }

  if (extension === '.jsonl' || extension === '.ndjson') {
    const values = [];
    for (const [index, line] of fileText.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        values.push(...collectStringValues(JSON.parse(line)));
      } catch (error) {
        errors.push(relativePath + ':' + (index + 1) + ': invalid JSONL record: ' + error.message);
      }
    }
    return values;
  }

  return [fileText];
}

async function scanProtectedDirectory(directory, prompts, report) {
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      report.errors.push(path.relative(report.rootDir, current) + ': could not read protected directory: ' + error.message);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(report.rootDir, fullPath);

      if (entry.isSymbolicLink()) {
        report.errors.push(relativePath + ': symbolic links are not allowed.');
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        report.errors.push(relativePath + ': unsupported filesystem entry in a protected directory.');
        continue;
      }
      if (!isAllowedTextFile(fullPath)) {
        report.errors.push(relativePath + ': unknown file type; quarantine cannot inspect it safely.');
        continue;
      }

      let buffer;
      try {
        const info = await lstat(fullPath);
        if (info.size > MAX_TEXT_FILE_BYTES) throw new Error('file exceeds the 15 MiB scan limit');
        buffer = await readFile(fullPath);
      } catch (error) {
        report.errors.push(relativePath + ': could not read protected file: ' + error.message);
        continue;
      }

      if (buffer.includes(0)) {
        report.errors.push(relativePath + ': binary content is not allowed in a protected text directory.');
        continue;
      }

      let fileText;
      try {
        // Fatal decoding means invalid UTF-8 fails closed instead of becoming replacement characters.
        fileText = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch (error) {
        report.errors.push(relativePath + ': file is not valid UTF-8 text: ' + error.message);
        continue;
      }

      report.scannedFiles += 1;
      const extension = path.extname(fullPath).toLowerCase();
      const searchableValues = extractSearchableText(fileText, extension, relativePath, report.errors);
      const normalizedValues = searchableValues.map(normalizePrompt).filter(Boolean);

      for (const prompt of prompts) {
        if (normalizedValues.some((value) => value.includes(prompt.text))) {
          report.errors.push(relativePath + ': exact benchmark prompt match found for ' + prompt.id + '.');
        }
      }
    }
  }

  await walk(directory.path);
}

export async function checkEvalQuarantine(rootDir = REPOSITORY_ROOT) {
  const prompts = [];
  const errors = [];

  await collectLegacyTaskPrompts(rootDir, prompts, errors);
  await collectFrozenJsonlPrompts(rootDir, prompts, errors);

  if (!prompts.length) errors.push('No evaluation prompts were found; quarantine cannot prove that the scan is complete.');

  const protectedDirectories = await discoverProtectedDirectories(rootDir, errors);
  const report = {
    rootDir,
    promptsChecked: prompts.length,
    protectedDirectories: protectedDirectories.map((item) => item.relativePath).sort(),
    scannedFiles: 0,
    errors
  };

  for (const directory of protectedDirectories) {
    await scanProtectedDirectory(directory, prompts, report);
  }

  return { ok: report.errors.length === 0, ...report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const report = await checkEvalQuarantine();
  console.log('Evaluation prompt quarantine');
  console.log('  Prompts checked: ' + report.promptsChecked);
  console.log('  Protected directories: ' + report.protectedDirectories.length);
  console.log('  Protected text files scanned: ' + report.scannedFiles);

  for (const error of report.errors) console.error('  FAIL ' + error);
  if (report.ok) console.log('  PASS no prompt leakage or unsupported protected files found.');
  else process.exitCode = 1;
}
