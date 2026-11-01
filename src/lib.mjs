export function clampInteger(value, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(Math.min(value, max), min);
}
