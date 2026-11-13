// Browser validation of model-supplied tool arguments with @cfworker/json-schema
// (MIT): full JSON Schema drafts 4 through 2020-12 ($ref, anyOf/oneOf, const,
// formats, ...) without eval, so it runs under the app's CSP where Ajv's
// generated code cannot. Like the Node side (src/tool-schema-validation.mjs),
// a schema without $schema is read as Draft-07.
import { Validator } from '@cfworker/json-schema';

const validators = new WeakMap();
// Summaries that only point at a nested error, which is reported on its own.
const WRAPPERS = new Set(['properties', 'items', 'prefixItems', 'additionalItems', 'patternProperties', 'false', '$ref', 'allOf']);

function dialectOf(schema) {
  const id = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (id.includes('2020-12')) return '2020-12';
  if (id.includes('2019-09')) return '2019-09';
  if (id.includes('draft-04')) return '4';
  return '7';
}

function validatorFor(schema) {
  if (typeof schema !== 'object') return new Validator(schema, '7', false);
  let validator = validators.get(schema);
  if (!validator) validators.set(schema, validator = new Validator(schema, dialectOf(schema), false));
  return validator;
}

function describe(error) {
  const at = error.instanceLocation.replace(/^#/, '') || '/';
  if (error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties') {
    const property = /Property "(.*)" does not match/.exec(error.error);
    if (property) return at + ' contains unsupported property "' + property[1] + '"';
  }
  return at + ' ' + error.error.replace(/^Instance /, '').replace(/\.$/, '');
}

export async function validateAppToolArguments(schema, args) {
  if (schema === undefined || schema === null) return { valid: true, skipped: true };
  let result;
  try { result = validatorFor(schema).validate(args); }
  catch (error) { return { valid: false, schemaError: String(error && error.message || error) }; }
  if (result.valid) return { valid: true, skipped: false };
  // Inside anyOf/oneOf/not, only the combinator's own summary is useful: the
  // per-branch failures are expected for every branch but the intended one.
  const errors = result.errors
    .filter((error) => !WRAPPERS.has(error.keyword) && !/\/(anyOf|oneOf|not|if|then|else)\/./.test(error.keywordLocation.replace(/^#/, '')))
    .map(describe);
  return { valid: false, errors: [...new Set(errors.length ? errors : result.errors.map(describe))].slice(0, 8) };
}
