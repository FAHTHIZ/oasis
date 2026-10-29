// Test-only ESM loader that simulates an installation without QuickJS.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'quickjs-emscripten') {
    const error = new Error("Cannot find package 'quickjs-emscripten' imported from " + context.parentURL);
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}
