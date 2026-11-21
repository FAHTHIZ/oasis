// Identical side-effecting calls in one model reply.
//
// Models (and some streaming gateways) sometimes emit the same tool call twice
// in a single reply: two identical `git commit` or `npm install x` calls, the
// same write_file twice, a duplicated tool_call delta. Running both repeats the
// side effect (two commits, a second append, a migration applied twice). A copy
// is only skipped when nothing but read-only calls sits between it and the
// original, so a deliberate "run tests, edit, run tests again" in one reply
// still runs both test commands. The skipped copy is answered with a pointer to
// the original's result, so the transcript stays valid.

export const SIDE_EFFECT_TOOLS = new Set([
  'run_command', 'run_shell', 'powershell',
  'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'delete_file', 'notebook_edit',
  'install_package', 'install_plugin', 'install_extension', 'install_external_skill', 'add_extension',
  'configure_mcp_server', 'configure_provider'
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined && value[key] !== null) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function signature(call) {
  const name = call && call.function && call.function.name;
  const raw = call && call.function && call.function.arguments;
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw || '{}'); } catch { return null; }
  }
  if (!args || typeof args !== 'object') return null;
  return name + '\0' + JSON.stringify(canonical(args));
}

/**
 * Map of duplicate call id -> id of the identical earlier call it repeats.
 * `isReadOnly(call)` marks calls that may sit between the two without making
 * the repeat meaningful.
 */
export function duplicateSideEffectCalls(calls, { isReadOnly = () => false, tools = SIDE_EFFECT_TOOLS } = {}) {
  const duplicates = new Map();
  if (!Array.isArray(calls) || calls.length < 2) return duplicates;
  let last = null; // the most recent side-effecting call that actually runs
  for (const call of calls) {
    const name = call && call.function && call.function.name;
    if (!call || !call.id) { last = null; continue; }
    if (isReadOnly(call)) continue;
    if (!tools.has(name)) { last = null; continue; }
    const sig = signature(call);
    if (sig && last && last.sig === sig) { duplicates.set(call.id, last.id); continue; }
    last = sig ? { sig, id: call.id } : null;
  }
  return duplicates;
}

export function duplicateCallNotice(name, originalId) {
  return 'Not executed: this ' + (name || 'tool') + ' call is identical to call ' + originalId +
    ' earlier in the same reply, so OASIS ran it only once to avoid repeating its side effects. Use that result. If you really need it to run again, call it again in your next step.';
}
