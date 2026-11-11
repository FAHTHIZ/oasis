import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMemory, nestedMemoryFor } from '../src/memory.mjs';
import { findRecipe, listRecipes, parseRecipeArguments, recipePrompt, renderRecipeTemplate } from '../src/goose-recipes.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-goose-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const root = path.join(repo, 'packages', 'app');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(home, '.config', 'goose'), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), CODEX_HOME: path.join(base, 'codex'), OASIS_OTHER_AGENT_RULES: '', GOOSE_RECIPE_PATH: '' };
  return { base, home, repo, root, env };
}

test('.goosehints load globally, from the git root down, and per nested folder', async (t) => {
  const { base, home, repo, root, env } = await fixture(t);
  await writeFile(path.join(base, '.goosehints'), 'ABOVE_GIT_ROOT_HINT\n');
  await writeFile(path.join(home, '.config', 'goose', '.goosehints'), 'GLOBAL_GOOSE_HINT\n');
  await writeFile(path.join(repo, '.goosehints'), 'REPO_ROOT_HINT\n');
  await writeFile(path.join(repo, 'packages', '.goosehints'), 'PACKAGES_HINT\n');
  await writeFile(path.join(root, '.goosehints'), 'APP_HINT\n');
  await writeFile(path.join(root, 'src', '.goosehints'), 'SRC_HINT\n');
  const text = await loadMemory(root, { env, home });
  for (const marker of ['GLOBAL_GOOSE_HINT', 'REPO_ROOT_HINT', 'PACKAGES_HINT', 'APP_HINT']) assert.match(text, new RegExp(marker));
  assert.doesNotMatch(text, /ABOVE_GIT_ROOT_HINT/);
  assert.ok(text.indexOf('REPO_ROOT_HINT') < text.indexOf('PACKAGES_HINT'));
  assert.doesNotMatch(text, /SRC_HINT/);
  const nested = await nestedMemoryFor(root, 'src/index.js', new Set(), { env });
  assert.ok(nested.some((item) => /SRC_HINT/.test(item.text)));
  const off = await loadMemory(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' }, home });
  assert.doesNotMatch(off, /GOOSE_HINT|REPO_ROOT_HINT|APP_HINT/);
  assert.equal((await nestedMemoryFor(root, 'src/index.js', new Set(), { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' } })).length, 0);
});

test('recipe templates, arguments and lookup', async (t) => {
  const { base, root, env } = await fixture(t);
  assert.deepEqual(parseRecipeArguments('lang=go title="two words" extra text'), { values: { lang: 'go', title: 'two words' }, rest: 'extra text' });
  assert.equal(renderRecipeTemplate('a {{ x }} {{y}} {{ missing }}\n  {{ body | indent(2) }}', { x: 1, y: 'b', body: 'l1\nl2' }), 'a 1 b {{ missing }}\n  l1\n  l2');
  const shared = path.join(base, 'shared');
  await mkdir(shared);
  await writeFile(path.join(shared, 'deploy.json'), JSON.stringify({ title: 'Deploy', description: 'Ship it', prompt: 'Deploy {{ env }}', parameters: [{ key: 'env', input_type: 'select', requirement: 'optional', default: 'staging', options: ['staging', 'prod'] }] }));
  await writeFile(path.join(root, 'review.yaml'), 'title: Review\ndescription: Review code\ninstructions: |\n  Review the {{ lang }} code in {{ recipe_dir }}.\nprompt: Focus on {{ focus }}.\nparameters:\n  - key: lang\n    input_type: string\n    requirement: required\n    description: language\n  - key: focus\n    input_type: string\n    requirement: optional\n    default: tests\nresponse:\n  json_schema:\n    type: object\n    properties:\n      ok: { type: boolean }\nextensions:\n  - type: stdio\n    name: github\n    cmd: gh-mcp\n');
  await writeFile(path.join(root, 'notes.yaml'), 'just: data\n');
  assert.equal(await findRecipe(root, 'review', env), path.join(root, 'review.yaml'));
  assert.equal(await findRecipe(root, 'deploy', env), null);
  const withPath = { ...env, GOOSE_RECIPE_PATH: shared };
  assert.equal(await findRecipe(root, 'deploy', withPath), path.join(shared, 'deploy.json'));
  assert.equal(await findRecipe(root, '../../../shared/deploy.json', env), null);
  assert.deepEqual((await listRecipes(root, withPath)).map((item) => item.name), ['review', 'deploy']);

  const missing = await recipePrompt(root, 'review', env);
  assert.match(missing.error, /needs: lang \(language\)/);
  const ok = await recipePrompt(root, 'review lang=go also check docs', env);
  assert.match(ok.prompt, /Review the go code in /);
  assert.ok(ok.prompt.includes(root));
  assert.match(ok.prompt, /Focus on tests\./);
  assert.match(ok.prompt, /Additional input: also check docs/);
  assert.match(ok.prompt, /JSON Schema:[\s\S]*"ok"/);
  assert.match(ok.output, /extensions not started[^\n]*github/);
  assert.match((await recipePrompt(root, 'deploy env=dev', withPath)).error, /must be one of: staging, prod/);
  assert.match((await recipePrompt(root, 'deploy', withPath)).prompt, /Deploy staging/);
  assert.match((await recipePrompt(root, 'notes', env)).error, /missing title/);

  const listed = await runBuiltinCommand('recipe', '', { root, env });
  assert.match(listed.output, /review\s+Review - Review code/);
  const run = await runBuiltinCommand('recipe', 'review lang=rust', { root, env });
  assert.match(run.prompt, /Review the rust code/);
});
