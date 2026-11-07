// Browser-safe validation for the IndexedDB workspace tool schemas.
// Keep this intentionally small: no Node imports, package loader or network.
function typeMatches(type, value) {
  if (Array.isArray(type)) return type.some((item) => typeMatches(item, value));
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function validateNode(schema, value, path, errors, depth) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  if (depth > 12) { errors.push(path + ' exceeds maximum schema depth'); return; }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(path + ' must be ' + (Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(path + ' must be one of the allowed values');
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(path + ' must contain at least ' + schema.minLength + ' characters');
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(path + ' must contain at most ' + schema.maxLength + ' characters');
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(value)) errors.push(path + ' does not match the required pattern'); }
      catch { errors.push(path + ' has an invalid pattern in its schema'); }
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(path + ' must be at least ' + schema.minimum);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(path + ' must be at most ' + schema.maximum);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(path + ' must contain at least ' + schema.minItems + ' items');
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(path + ' must contain at most ' + schema.maxItems + ' items');
    if (schema.items && typeof schema.items === 'object') {
      for (let index = 0; index < Math.min(value.length, 100); index++) validateNode(schema.items, value[index], path + '[' + index + ']', errors, depth + 1);
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(path + ' is missing required property "' + key + '"');
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) validateNode(properties[key], child, path + '.' + key, errors, depth + 1);
      else if (schema.additionalProperties === false) errors.push(path + ' contains unsupported property "' + key + '"');
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateNode(schema.additionalProperties, child, path + '.' + key, errors, depth + 1);
    }
  }
}

export async function validateAppToolArguments(schema, args) {
  if (schema === undefined || schema === null) return { valid: true, skipped: true };
  const errors = [];
  validateNode(schema, args, '/', errors, 0);
  return errors.length ? { valid: false, errors: errors.slice(0, 8) } : { valid: true, skipped: false };
}
