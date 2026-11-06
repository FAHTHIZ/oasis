// JSON Schema validation for headless --json-schema output, workflow steps and the SDK,
// by Ajv (draft 2020-12 by default; draft-07 when the schema's $schema names it).
// Returns readable errors such as `$.bugs[0].file: expected string, got number`.
import Ajv2020 from 'ajv/dist/2020.js';
import AjvDraft7 from 'ajv';

const OPTIONS = { allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true };
let engines = null;
function engine(schema) {
  if (!engines) engines = { modern: new Ajv2020(OPTIONS), draft7: new AjvDraft7(OPTIONS) };
  return /draft-0[4-7]/.test(String(schema && schema.$schema || '')) ? engines.draft7 : engines.modern;
}

const compiled = new WeakMap();
function compile(schema) {
  if (schema && typeof schema === 'object' && compiled.has(schema)) return compiled.get(schema);
  // Drop $id so the same schema can be compiled again after an edit without an id clash.
  const copy = schema && typeof schema === 'object' ? { ...schema } : schema;
  if (copy && typeof copy === 'object') delete copy.$id;
  const validate = engine(schema).compile(copy);
  if (schema && typeof schema === 'object') compiled.set(schema, validate);
  return validate;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function jsonPath(pointer) {
  return '$' + String(pointer || '').split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((part) => (/^\d+$/.test(part) ? '[' + part + ']' : /^[A-Za-z_$][\w$]*$/.test(part) ? '.' + part : '[' + JSON.stringify(part) + ']')).join('');
}

function valueAt(root, pointer) {
  return String(pointer || '').split('/').slice(1).reduce((node, part) => (node == null ? node : node[part.replace(/~1/g, '/').replace(/~0/g, '~')]), root);
}

function describe(error, root) {
  const at = jsonPath(error.instancePath);
  const p = error.params || {};
  switch (error.keyword) {
    case 'type': return at + ': expected ' + [].concat(p.type).join(' or ').split(',').join(' or ') + ', got ' + typeOf(valueAt(root, error.instancePath));
    case 'required': return at + ': missing required property "' + p.missingProperty + '"';
    case 'additionalProperties': return at + ': unexpected property "' + p.additionalProperty + '"';
    case 'unevaluatedProperties': return at + ': unexpected property "' + p.unevaluatedProperty + '"';
    case 'enum': return at + ': must be one of ' + (p.allowedValues || []).map((item) => JSON.stringify(item)).join(', ');
    case 'const': return at + ': must equal ' + JSON.stringify(p.allowedValue);
    case 'minLength': return at + ': shorter than ' + p.limit + ' characters';
    case 'maxLength': return at + ': longer than ' + p.limit + ' characters';
    case 'pattern': return at + ': does not match ' + p.pattern;
    case 'minItems': return at + ': fewer than ' + p.limit + ' items';
    case 'maxItems': return at + ': more than ' + p.limit + ' items';
    case 'minimum': return at + ': less than ' + p.limit;
    case 'maximum': return at + ': greater than ' + p.limit;
    case 'exclusiveMinimum': return at + ': must be greater than ' + p.limit;
    case 'exclusiveMaximum': return at + ': must be less than ' + p.limit;
    case 'uniqueItems': return at + ': items must be unique';
    case 'anyOf': return at + ': does not match any allowed shape';
    case 'oneOf': return at + ': must match exactly one allowed shape';
    case 'false schema': return at + ': no value is allowed here';
    default: return at + ': ' + (error.message || error.keyword);
  }
}

/** Validates value against a JSON Schema. Returns [] when it conforms, else readable errors (at most 50). */
export function validateJsonSchema(schema, value) {
  if (schema === true || schema === undefined) return [];
  let validate;
  try { validate = compile(schema); } catch (error) { return ['$: the JSON Schema itself is invalid: ' + (error.message || String(error))]; }
  if (validate(value)) return [];
  // anyOf/oneOf report their branch errors too; keep the summary line for those paths.
  const errors = validate.errors || [];
  const combined = new Set(errors.filter((error) => error.keyword === 'anyOf' || error.keyword === 'oneOf').map((error) => error.schemaPath.replace(/\/(anyOf|oneOf)$/, '')));
  const kept = errors.filter((error) => error.keyword === 'anyOf' || error.keyword === 'oneOf' || ![...combined].some((prefix) => error.schemaPath.startsWith(prefix + '/anyOf/') || error.schemaPath.startsWith(prefix + '/oneOf/')));
  return [...new Set(kept.map((error) => describe(error, value)))].slice(0, 50);
}

// Pulls a JSON value out of a model reply: the whole text, a ```json fence, or
// the outermost {...} / [...] span.
export function extractJson(text) {
  const source = String(text || '').trim();
  const attempts = [source];
  const fence = source.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) attempts.push(fence[1]);
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = source.indexOf(open);
    const end = source.lastIndexOf(close);
    if (start >= 0 && end > start) attempts.push(source.slice(start, end + 1));
  }
  for (const attempt of attempts) {
    try { return { ok: true, value: JSON.parse(attempt) }; } catch {}
  }
  return { ok: false };
}
