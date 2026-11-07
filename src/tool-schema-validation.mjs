// Validate model-supplied tool arguments against the same JSON Schema that
// is advertised to the provider. Compilation is cached per schema object and
// validation never coerces or mutates the caller's arguments.
import Ajv from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateFormats: false,
  addUsedSchema: false,
});
const validators = new WeakMap();

function validatorFor(schema) {
  if (!schema || typeof schema !== 'object') {
    return ajv.compile(schema);
  }
  const cached = validators.get(schema);
  if (cached) return cached;
  const validator = ajv.compile(schema);
  validators.set(schema, validator);
  return validator;
}

function describeErrors(errors) {
  return errors.slice(0, 8).map((error) => {
    const at = error.instancePath || '/';
    if (error.keyword === 'required') return at + ' is missing required property "' + error.params.missingProperty + '"';
    if (error.keyword === 'additionalProperties') return at + ' contains unsupported property "' + error.params.additionalProperty + '"';
    return at + ' ' + (error.message || 'is invalid');
  });
}

export function validateToolArguments(schema, args) {
  if (schema === undefined || schema === null) return { valid: true, skipped: true };
  let validate;
  try {
    validate = validatorFor(schema);
  } catch (error) {
    return { valid: false, schemaError: String(error && error.message || error) };
  }
  if (validate(args)) return { valid: true, skipped: false };
  return { valid: false, errors: describeErrors(validate.errors || []) };
}
