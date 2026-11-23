// DM pairing for the messaging gateways. Someone who is not on a platform's
// allowlist gets a one-time code instead of silence; the owner approves it on
// the machine running OASIS with `oasis gateway pair CODE`, and from then on
// that person can use the agent on that platform. Nobody can approve
// themselves from a chat: codes are only accepted on the command line.
//
// Approvals live in the user's OASIS config folder (gateway/pairing/<hash of
// the workspace path>.json, mode 0600), one file per workspace. They used to
// be in the workspace's .oasis/gateway/pairing.json, where a cloned repository
// or the model's own file edits could add an attacker's chat ID. That file is
// no longer read; `oasis gateway paired` lists what it holds so the owner can
// pair those people again. Approvals are re-read on every check so a running
// gateway picks them up at once, and
// can be listed with `oasis gateway paired` and revoked with
// `oasis gateway unpair PLATFORM:ID`. OASIS_GATEWAY_PAIRING=0 turns pairing off,
// leaving only the allowlist variables.
import { createHash, randomInt } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING = 20;

export function pairingEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.OASIS_GATEWAY_PAIRING || ''));
}

function workspaceId(root) {
  const resolved = path.resolve(root || process.cwd());
  try { return realpathSync(resolved); } catch { return resolved; }
}

export function pairingFile(root, env = process.env) {
  const id = createHash('sha256').update(workspaceId(root)).digest('hex').slice(0, 32);
  return path.join(getConfigDirectory(env), 'gateway', 'pairing', id + '.json');
}

/** Where pairings used to be kept, inside the workspace; never trusted now. */
export function legacyPairingFile(root) {
  return path.join(path.resolve(root || process.cwd()), '.oasis', 'gateway', 'pairing.json');
}

function load(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return { paired: data && typeof data.paired === 'object' && data.paired ? data.paired : {}, pending: data && typeof data.pending === 'object' && data.pending ? data.pending : {} };
  } catch { return { paired: {}, pending: {} }; }
}

function save(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(temp, 0o600); } catch { /* Windows */ }
  renameSync(temp, file);
}

export function newPairingCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code.slice(0, 4) + '-' + code.slice(4);
}

const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

/**
 * One platform's view: isPaired(id) and request(id, label) -> code or null
 * (null when pairing is off or too many requests are waiting).
 */
export function createPairing({ platform, root, env = process.env, now = () => Date.now(), log = () => {} } = {}) {
  const file = pairingFile(root, env);
  const enabled = pairingEnabled(env);
  const keyOf = (id) => platform + ':' + String(id);
  return {
    enabled,
    isPaired(id) {
      if (!enabled || id === undefined || id === null || id === '') return false;
      return Object.prototype.hasOwnProperty.call(load(file).paired, keyOf(id));
    },
    request(id, label = '') {
      if (!enabled) return null;
      const data = load(file);
      const key = keyOf(id);
      const time = now();
      for (const [code, item] of Object.entries(data.pending)) if (!item || item.expires <= time) delete data.pending[code];
      const existing = Object.entries(data.pending).find(([, item]) => item.key === key);
      if (existing) return existing[0];
      if (Object.keys(data.pending).length >= MAX_PENDING) return null;
      const code = newPairingCode();
      data.pending[code] = { key, label: String(label || '').slice(0, 120), expires: time + CODE_TTL_MS };
      data.workspace = workspaceId(root);
      save(file, data);
      log('pairing request from ' + key + (label ? ' (' + String(label).slice(0, 60) + ')' : '') + ': approve with oasis gateway pair ' + code);
      return code;
    }
  };
}

/** The reply a stranger gets: their ID, plus a pairing code when pairing is on. */
export function strangerMessage({ pairing, id, label = '', idName, envName }) {
  const code = pairing && pairing.request(id, label);
  const who = 'Your ' + idName + ' is ' + (label && label !== String(id) ? label + ' (' + id + ')' : id) + '.';
  return code
    ? 'You are not allowed to use this agent yet. ' + who + ' To get access, ask the owner to run this on the OASIS machine:\n\noasis gateway pair ' + code + '\n\nThe code expires in an hour.'
    : 'You are not allowed to use this agent. ' + who + ' Ask the owner to add it to ' + envName + '.';
}

/** `oasis gateway pair CODE | paired | unpair PLATFORM:ID` */
export function pairingCommand(args = [], { root, env = process.env, now = () => Date.now() } = {}) {
  const [action, value] = args;
  const file = pairingFile(root, env);
  const data = load(file);
  if (action === 'pair') {
    const code = normalizeCode(value);
    if (!code) throw new Error('Usage: oasis gateway pair CODE');
    const item = data.pending[code];
    if (!item || item.expires <= now()) throw new Error('No pending pairing request with code ' + code + '. Codes expire after an hour; ask for a new one by messaging the bot again.');
    delete data.pending[code];
    data.paired[item.key] = { label: item.label, at: new Date(now()).toISOString() };
    save(file, data);
    return 'Paired ' + item.key + (item.label ? ' (' + item.label + ')' : '') + '. They can use the agent now; oasis gateway unpair ' + item.key + ' revokes it.';
  }
  if (action === 'unpair') {
    const key = String(value || '').trim();
    if (!key) throw new Error('Usage: oasis gateway unpair PLATFORM:ID (see oasis gateway paired)');
    if (!data.paired[key]) throw new Error(key + ' is not paired. oasis gateway paired lists who is.');
    delete data.paired[key];
    save(file, data);
    return 'Unpaired ' + key + '.';
  }
  if (action === 'paired') {
    const rows = Object.entries(data.paired).map(([key, item]) => '  ' + key + (item.label ? '  ' + item.label : '') + (item.at ? '  since ' + item.at.slice(0, 10) : ''));
    const waiting = Object.entries(data.pending).filter(([, item]) => item.expires > now()).map(([code, item]) => '  ' + code + '  ' + item.key + (item.label ? '  ' + item.label : ''));
    const legacy = Object.keys(load(legacyPairingFile(root)).paired);
    const legacyNote = legacy.length ? '\nNot active: ' + legacy.slice(0, 20).join(', ') + (legacy.length > 20 ? ', ...' : '') + ' (from ' + legacyPairingFile(root) +
      ', inside the workspace, which a repository or a file edit could have written; OASIS no longer reads it). Pair them again if you know them, then delete that file.' : '';
    return (rows.length ? 'Paired:\n' + rows.join('\n') : 'Nobody is paired yet.') + (waiting.length ? '\nWaiting for approval (oasis gateway pair CODE):\n' + waiting.join('\n') : '') + legacyNote;
  }
  throw new Error('Usage: oasis gateway pair CODE | paired | unpair PLATFORM:ID');
}

/** An allowlist that also accepts paired IDs (has, size and iteration stay the allowlist's own). */
export function withPairing(allowlist, pairing) {
  const base = allowlist instanceof Set ? allowlist : new Set(allowlist || []);
  return {
    has: (id) => base.has(id) || Boolean(pairing && pairing.isPaired(id)),
    get size() { return base.size; },
    [Symbol.iterator]: () => base[Symbol.iterator](),
    base
  };
}
