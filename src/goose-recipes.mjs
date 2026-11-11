// Goose recipes (block/goose, Apache-2.0), run as `/recipe FILE|NAME [key=value ...]`.
// Reimplemented from the documented format (block.github.io/goose/docs/guides/recipes/
// recipe-reference); no Goose code is copied.
//
//   title, description            required
//   instructions, prompt          at least one; {{ key }} placeholders, `| indent(n)` filter
//   parameters                    key, input_type, requirement (required | optional | user_prompt),
//                                 description, default, options (for select)
//   response.json_schema          the final answer must be JSON matching this schema
//   extensions, sub_recipes, retry, settings   reported, not run
//
// Lookup: a path (inside the workspace), else NAME.yaml / NAME.json in the workspace and in
// each GOOSE_RECIPE_PATH folder (Goose's local discovery). `.yml` is accepted too.
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const MAX_RECIPE_BYTES = 256 * 1024;
const EXTENSIONS = ['.yaml', '.json', '.yml'];

function recipeDirs(root, env) {
  const extra = String(env.GOOSE_RECIPE_PATH || '').split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  return [path.resolve(root), ...extra.map((dir) => path.resolve(root, dir))];
}

async function isFile(file) {
  try { const info = await stat(file); return info.isFile() && info.size <= MAX_RECIPE_BYTES; } catch { return false; }
}

/** Finds a recipe by path or name. Returns the absolute file or null. */
export async function findRecipe(root, ref, env = process.env) {
  const wanted = String(ref || '').trim();
  if (!wanted || wanted.includes('\0')) return null;
  const workspace = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  if (/[\\/]/.test(wanted) || EXTENSIONS.some((ext) => wanted.toLowerCase().endsWith(ext))) {
    const file = path.resolve(workspace, wanted);
    const real = await realpath(file).catch(() => null);
    const relative = real ? path.relative(workspace, real) : '..';
    const inGooseDirs = real && recipeDirs(root, env).slice(1).some((dir) => { const rel = path.relative(dir, real); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
    if (real && (inGooseDirs || (!relative.startsWith('..') && !path.isAbsolute(relative))) && await isFile(real)) return real;
    if (!/[\\/]/.test(wanted)) {
      for (const dir of recipeDirs(root, env).slice(1)) if (await isFile(path.join(dir, wanted))) return path.join(dir, wanted);
    }
    return null;
  }
  if (!/^[\w.-]{1,100}$/.test(wanted)) return null;
  for (const dir of recipeDirs(root, env)) {
    for (const ext of EXTENSIONS) {
      const file = path.join(dir, wanted + ext);
      if (await isFile(file)) return file;
    }
  }
  return null;
}

/** Recipe files in the workspace root and GOOSE_RECIPE_PATH folders. */
export async function listRecipes(root, env = process.env) {
  const out = [];
  for (const dir of recipeDirs(root, env)) {
    let names = [];
    try { names = (await readdir(dir)).sort(); } catch { continue; }
    for (const name of names) {
      if (!EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) continue;
      const file = path.join(dir, name);
      try {
        const recipe = parseRecipe(await readFile(file, 'utf8'));
        out.push({ name: name.replace(/\.(?:ya?ml|json)$/i, ''), file, title: recipe.title, description: recipe.description });
      } catch { /* not a recipe */ }
      if (out.length >= 100) return out;
    }
  }
  return out;
}

/** Parses and checks a recipe. Throws with a readable message. */
export function parseRecipe(text) {
  let data;
  try { data = parseYaml(String(text), { schema: 'core', maxAliasCount: 50 }); } catch (error) { throw new Error('not valid YAML or JSON: ' + String(error.message).split('\n')[0]); }
  // Goose also accepts a recipe nested under `recipe:` (shared deeplink exports).
  if (data && typeof data === 'object' && data.recipe && typeof data.recipe === 'object' && !data.title) data = data.recipe;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('a recipe is a YAML or JSON object');
  const text2 = (value) => typeof value === 'string' ? value : '';
  if (!text2(data.title).trim()) throw new Error('missing title');
  if (!text2(data.description).trim()) throw new Error('missing description');
  if (!text2(data.instructions).trim() && !text2(data.prompt).trim()) throw new Error('needs instructions or prompt');
  const parameters = Array.isArray(data.parameters) ? data.parameters.filter((item) => item && typeof item === 'object' && /^[A-Za-z_][\w-]{0,63}$/.test(String(item.key || ''))) : [];
  return { ...data, parameters };
}

/** Splits `key=value key2="two words" rest` into values and leftover text. */
export function parseRecipeArguments(text) {
  const values = {};
  const rest = [];
  const pattern = /([A-Za-z_][\w-]{0,63})=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    if (match[3] !== undefined) { rest.push(match[3]); continue; }
    let value = match[2];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    else if (value.startsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return { values, rest: rest.join(' ') };
}

/** Replaces {{ key }} and {{ key | indent(n) }}; unknown names stay as written. */
export function renderRecipeTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*([A-Za-z_][\w-]*)\s*(?:\|\s*indent\(\s*(\d{1,2})\s*\)\s*)?\}\}/g, (whole, key, indent) => {
    if (!Object.hasOwn(values, key)) return whole;
    const value = String(values[key]);
    if (!indent) return value;
    const pad = ' '.repeat(Number(indent));
    return value.split('\n').map((line, index) => index === 0 || !line ? line : pad + line).join('\n');
  });
}

/**
 * Builds the prompt for a recipe. Returns { prompt, output } or { error }.
 * Parameters come from key=value pairs; missing required and user_prompt values
 * are reported so the user can pass them (OASIS does not open a form here).
 */
export async function recipePrompt(root, argumentText, env = process.env) {
  const trimmed = String(argumentText || '').trim();
  const [ref, ...restWords] = trimmed.split(/\s+/);
  const file = await findRecipe(root, ref, env);
  if (!file) return { error: 'No recipe "' + ref + '" in the workspace or GOOSE_RECIPE_PATH.' };
  let recipe;
  try { recipe = parseRecipe(await readFile(file, 'utf8')); } catch (error) { return { error: 'Recipe ' + file + ': ' + error.message }; }
  const { values: given, rest } = parseRecipeArguments(restWords.join(' '));
  const values = { recipe_dir: path.dirname(file) };
  const missing = [];
  for (const param of recipe.parameters) {
    const key = String(param.key);
    const requirement = String(param.requirement || 'required').toLowerCase();
    let value = given[key];
    if (value === undefined && param.default !== undefined && param.default !== null && requirement !== 'required') value = String(param.default);
    if (value === undefined) {
      if (requirement === 'optional') value = '';
      else { missing.push(key + (param.description ? ' (' + String(param.description) + ')' : '')); continue; }
    }
    if (String(param.input_type || '').toLowerCase() === 'select' && Array.isArray(param.options) && value !== '' && !param.options.map(String).includes(value)) {
      return { error: 'Parameter ' + key + ' must be one of: ' + param.options.map(String).join(', ') };
    }
    values[key] = value;
  }
  if (missing.length) return { error: 'Recipe "' + recipe.title + '" needs: ' + missing.join('; ') + '. Pass them as key=value after the recipe name.' };
  const instructions = renderRecipeTemplate(recipe.instructions, values).trim();
  const prompt = renderRecipeTemplate(recipe.prompt, values).trim();
  const parts = ['Run the Goose recipe "' + recipe.title + '": ' + String(recipe.description).trim()];
  if (instructions) parts.push('Recipe instructions:\n' + instructions);
  parts.push(prompt || 'Start the task the recipe instructions describe.');
  if (rest) parts.push('Additional input: ' + rest);
  if (recipe.response && typeof recipe.response === 'object' && recipe.response.json_schema && typeof recipe.response.json_schema === 'object') {
    parts.push('Finish with only a JSON object that matches this JSON Schema:\n' + JSON.stringify(recipe.response.json_schema, null, 2));
  }
  const notes = [];
  const extensionNames = Array.isArray(recipe.extensions) ? recipe.extensions.map((item) => item && (item.name || item.cmd || item.uri)).filter(Boolean).map(String) : [];
  if (extensionNames.length) notes.push('extensions not started (connect them as MCP servers with /mcp or /add): ' + extensionNames.join(', '));
  if (Array.isArray(recipe.sub_recipes) && recipe.sub_recipes.length) notes.push('sub_recipes are not run');
  if (recipe.retry) notes.push('retry checks are not run');
  if (recipe.settings && typeof recipe.settings === 'object' && (recipe.settings.goose_model || recipe.settings.goose_provider)) notes.push('settings.goose_provider/goose_model are ignored; the session model is used');
  return { prompt: parts.join('\n\n'), output: '[recipe] ' + recipe.title + ' (' + path.basename(file) + ')' + (notes.length ? '\nNote: ' + notes.join('; ') + '.' : ''), file, recipe };
}
