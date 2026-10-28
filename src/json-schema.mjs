// A small JSON Schema validator (the common subset of draft 2020-12) for
// headless --json-schema output. Returns a list of readable errors.
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  return type === actual || (type === 'number' && actual === 'integer');
}

export function validateJsonSchema(schema, value, at = '$', errors = [], root = schema) {
  if (errors.length > 50 || schema === true || schema === undefined) return errors;
  if (schema === false) { errors.push(at + ': no value is allowed here'); return errors; }
  if (schema.$ref && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node && node[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    return validateJsonSchema(target, value, at, errors, root);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) { errors.push(at + ': expected ' + types.join(' or ') + ', got ' + typeOf(value)); return errors; }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(at + ': must equal ' + JSON.stringify(schema.const));
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(at + ': must be one of ' + schema.enum.map((item) => JSON.stringify(item)).join(', '));
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(at + ': shorter than ' + schema.minLength + ' characters');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(at + ': longer than ' + schema.maxLength + ' characters');
    if (schema.pattern) { try { if (!new RegExp(schema.pattern, 'u').test(value)) errors.push(at + ': does not match ' + schema.pattern); } catch {} }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(at + ': less than ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(at + ': greater than ' + schema.maximum);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(at + ': must be greater than ' + schema.exclusiveMinimum);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(at + ': must be less than ' + schema.exclusiveMaximum);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(at + ': fewer than ' + schema.minItems + ' items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(at + ': more than ' + schema.maxItems + ' items');
    if (schema.items && typeof schema.items === 'object') value.forEach((item, index) => validateJsonSchema(schema.items, item, at + '[' + index + ']', errors, root));
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(at + ': items must be unique');
  }
  if (typeOf(value) === 'object') {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(at + ': missing required property "' + key + '"');
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateJsonSchema(properties[key], item, at + '.' + key, errors, root);
      else if (schema.additionalProperties === false) errors.push(at + ': unexpected property "' + key + '"');
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateJsonSchema(schema.additionalProperties, item, at + '.' + key, errors, root);
    }
  }
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) validateJsonSchema(part, value, at, errors, root);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => !validateJsonSchema(part, value, at, [], root).length)) errors.push(at + ': does not match any allowed shape');
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part) => !validateJsonSchema(part, value, at, [], root).length).length !== 1) errors.push(at + ': must match exactly one allowed shape');
  return errors;
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
