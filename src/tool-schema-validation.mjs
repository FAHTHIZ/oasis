// Validate model-supplied tool arguments against the same JSON Schema that
// is advertised to the provider. Ajv is loaded on first actual validation so
// ordinary CLI startup does not pay for a tool-specific dependency.
let ajvPromise;
let ajv2020Promise;
const validators = new WeakMap();

async function getAjv(options = {}) {
  // An explicit $schema declaration wins over the caller's preferred dialect.
  // This matters when an MCP tool publishes a Draft-07 schema but its
  // structured output is otherwise validated using the 2020-12 default.
  const explicitDialect = typeof options.schemaDialect === 'string' && options.schemaDialect.trim();
  const use2020 = explicitDialect
    ? explicitDialect.includes('2020-12')
    : options.dialect === '2020-12';
  if (use2020) {
    if (!ajv2020Promise) {
      ajv2020Promise = import('ajv/dist/2020.js').then(({ default: Ajv2020 }) => new Ajv2020({
        allErrors: true,
        strict: false,
        allowUnionTypes: true,
        validateFormats: false,
        addUsedSchema: false
      }));
    }
    return ajv2020Promise;
  }
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

async function validatorFor(schema, options = {}) {
  const ajv = await getAjv({
    dialect: options.dialect,
    schemaDialect: schema && typeof schema === 'object' ? schema.$schema : ''
  });
  if (!schema || typeof schema !== 'object') return ajv.compile(schema);
  const explicitDialect = typeof schema.$schema === 'string' && schema.$schema.trim();
  const cacheKey = explicitDialect
    ? (explicitDialect.includes('2020-12') ? '2020-12' : 'default')
    : (options.dialect === '2020-12' ? '2020-12' : 'default');
  let cache = validators.get(schema);
  if (!cache) {
    cache = new Map();
    validators.set(schema, cache);
  }
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const validator = ajv.compile(schema);
  cache.set(cacheKey, validator);
  return validator;
}

function describeErrors(errors) {
  return errors.slice(0, 8).map((error) => {
    const at = error.instancePath || '/';
    if (error.keyword === 'required') return at + ' is missing required property "' + error.params.missingProperty + '"';
    if (error.keyword === 'additionalProperties') return at + ' contains unexpected property "' + error.params.additionalProperty + '"';
    if (error.keyword === 'type') return at + ' must be ' + error.params.type + ' (expected ' + error.params.type + ')';
    return at + ' ' + (error.message || 'is invalid');
  });
}

export async function validateToolArguments(schema, args, options = {}) {
  if (schema === undefined || schema === null) return { valid: true, skipped: true };
  let validate;
  try {
    validate = await validatorFor(schema, options);
  } catch (error) {
    return { valid: false, schemaError: String(error && error.message || error) };
  }
  if (validate(args)) return { valid: true, skipped: false };
  return { valid: false, errors: describeErrors(validate.errors || []) };
}
