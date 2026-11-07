// Validate model-supplied tool arguments against the same JSON Schema that
// is advertised to the provider. Ajv is loaded on first actual validation so
// ordinary CLI startup does not pay for a tool-specific dependency.
let ajvPromise;
const validators = new WeakMap();

async function getAjv() {
  if (!ajvPromise) {
    ajvPromise = import('ajv').then(({ default: Ajv }) => new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
      validateFormats: false,
      addUsedSchema: false
    }));
  }
  return ajvPromise;
}

async function validatorFor(schema) {
  const ajv = await getAjv();
  if (!schema || typeof schema !== 'object') return ajv.compile(schema);
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
    if (error.keyword === 'type') return at + ' expected ' + error.params.type;
    return at + ' ' + (error.message || 'is invalid');
  });
}

export async function validateToolArguments(schema, args) {
  if (schema === undefined || schema === null) return { valid: true, skipped: true };
  let validate;
  try {
    validate = await validatorFor(schema);
  } catch (error) {
    return { valid: false, schemaError: String(error && error.message || error) };
  }
  if (validate(args)) return { valid: true, skipped: false };
  return { valid: false, errors: describeErrors(validate.errors || []) };
}
