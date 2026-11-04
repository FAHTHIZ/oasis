// Guarded procedural learning: turn verified, repeatable work into reviewable Agent Skills.
// Proposals stay local and inert until the user explicitly promotes them with
// /learning approve <id>. Skill text never changes runtime permissions.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { redactSecrets } from './auto-memory.mjs';

const MAX_PROPOSALS_PER_SCOPE = 50;
const MAX_BODY_CHARS = 20_000;
const MAX_EVIDENCE_CHARS = 1_000;
const REQUIRED_HEADINGS = [
  'Purpose',
  'Inputs',
  'Workflow',
  'Required provider capabilities',
  'Permissions',
  'Success criteria'
];

export function learningEnabled(settings = {}, env = process.env) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_AUTO_LEARNING || ''))) return false;
  return !(settings && settings.autoLearning === false);
}

export function assertLearningVerification(state, issues = []) {
  if (!state || !(state.changedPaths instanceof Set)) {
    throw new Error('Procedural learning requires the live OASIS verification state. The proposal was not saved.');
  }
  if (!Array.isArray(issues)) {
    throw new Error('Procedural learning could not validate the verification result. The proposal was not saved.');
  }
  if (issues.length) {
    throw new Error('Cannot save a procedural-learning proposal until OASIS verification is complete: ' + issues.join('; ') + '. Review the complete diff and pass a relevant check after the latest code edit.');
  }
  return true;
}

function projectKey(root) {
  // Store a stable opaque project identifier, not the absolute workspace path.
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
}

function normalizeScope(scope) {
  return scope === 'user' ? 'user' : 'project';
}

function proposalSegments(root, scope) {
  return normalizeScope(scope) === 'user'
    ? ['learning', 'user', 'proposals']
    : ['learning', 'projects', projectKey(root), 'proposals'];
}

async function assertDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Learning storage contains a non-directory or symbolic link: ' + directory);
  }
}

async function ensureDirectoryChain(base, segments) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  await assertDirectory(base);
  let current = path.resolve(base);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    await assertDirectory(current);
  }
  return current;
}

async function ensureProposalDirectory(root, scope, env) {
  const config = path.resolve(getConfigDirectory(env));
  return ensureDirectoryChain(config, proposalSegments(root, scope));
}

async function atomicWrite(file, content) {
  const temporary = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function oneLine(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validateTextWithoutSecrets(label, value, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max || text.includes('\0')) {
    throw new Error(label + ' must be non-empty and no longer than ' + max + ' characters.');
  }
  const cleaned = redactSecrets(text);
  if (cleaned.redacted) {
    throw new Error(label + ' appears to contain a secret or private marker. Remove it before proposing a skill.');
  }
  return text;
}

function validateSkillBody(value) {
  const body = validateTextWithoutSecrets('Skill body', value, MAX_BODY_CHARS);
  if (body.length < 250) {
    throw new Error('Skill body is too short. Include a complete, reusable procedure and its acceptance criteria.');
  }
  if (/^---\s*$/m.test(body.split('\n').slice(0, 4).join('\n'))) {
    throw new Error('Do not include front matter; OASIS generates it during promotion.');
  }
  const missing = REQUIRED_HEADINGS.filter((heading) =>
    !new RegExp('^#{1,3}\\s+' + heading.replace(/ /g, '\\s+') + '\\s*$', 'im').test(body)
  );
  if (missing.length) {
    throw new Error('Skill body is missing required headings: ' + missing.join(', ') + '.');
  }
  return body;
}

function validateName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,48}$/.test(name)) {
    throw new Error('Skill name must be a lowercase identifier: 2–49 letters, numbers, or hyphens, starting with a letter.');
  }
  return name;
}

function parseProposal(source, file, scope) {
  const item = JSON.parse(source);
  if (!item || item.schemaVersion !== 1 || !/^[a-f0-9]{16}$/.test(String(item.id || ''))) return null;
  if (!['pending', 'approved', 'rejected'].includes(item.status)) return null;
  if (!['project', 'user'].includes(item.scope) || item.scope !== scope) return null;
  return { ...item, file, scope };
}

async function readProposalsInScope(root, scope, env) {
  const base = path.resolve(getConfigDirectory(env));
  let directory = base;
  const segments = proposalSegments(root, scope);
  try { await assertDirectory(directory); } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  for (const segment of segments) {
    directory = path.join(directory, segment);
    try { await assertDirectory(directory); } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const proposals = [];
  for (const entry of entries.filter((item) => item.isFile() && !item.isSymbolicLink() && /^[a-f0-9]{16}\.json$/.test(item.name)).slice(0, MAX_PROPOSALS_PER_SCOPE)) {
    const file = path.join(directory, entry.name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) continue;
      const proposal = parseProposal(await readFile(file, 'utf8'), file, scope);
      if (proposal) proposals.push(proposal);
    } catch { /* Ignore malformed or unreadable local proposal files. */ }
  }
  return proposals.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listSkillProposals(root, { env = process.env, scope = null } = {}) {
  const scopes = scope ? [normalizeScope(scope)] : ['user', 'project'];
  const all = [];
  for (const item of scopes) all.push(...await readProposalsInScope(root, item, env));
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getSkillProposal(root, id, { env = process.env } = {}) {
  const wanted = String(id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(wanted)) throw new Error('Proposal ID must be 16 hexadecimal characters.');
  const proposals = await listSkillProposals(root, { env });
  return proposals.find((item) => item.id === wanted) || null;
}

async function persistProposal(proposal) {
  const safe = { ...proposal };
  delete safe.file;
  await atomicWrite(proposal.file, JSON.stringify(safe, null, 2) + '\n');
}

export async function createSkillProposal(root, input = {}, { env = process.env, session = null } = {}) {
  const scope = normalizeScope(input.scope);
  const name = validateName(input.name);
  const description = oneLine(validateTextWithoutSecrets('Description', input.description, 180), 180);
  if (description.length < 12) throw new Error('Description must contain at least 12 characters.');
  const body = validateSkillBody(input.body);
  const evidence = oneLine(validateTextWithoutSecrets('Evidence', input.evidence, MAX_EVIDENCE_CHARS), MAX_EVIDENCE_CHARS);
  if (evidence.length < 12) throw new Error('Evidence must identify a meaningful task result, changed files, or a verification check.');

  const proposals = await readProposalsInScope(root, scope, env);
  if (proposals.length >= MAX_PROPOSALS_PER_SCOPE) {
    throw new Error('This scope already has ' + MAX_PROPOSALS_PER_SCOPE + ' proposals. Reject or promote old proposals before adding another.');
  }
  const createdAt = new Date().toISOString();
  const id = randomBytes(8).toString('hex');
  const directory = await ensureProposalDirectory(root, scope, env);
  const file = path.join(directory, id + '.json');
  const proposal = {
    schemaVersion: 1,
    id,
    name,
    description,
    scope,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    sourceSession: oneLine(session && session.sessionId, 120) || null,
    evidence,
    body
  };
  await atomicWrite(file, JSON.stringify(proposal, null, 2) + '\n');
  return { id, name, description, scope, status: 'pending', createdAt, evidence };
}

function ensureInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function createSkillDirectory(base, name) {
  const resolvedBase = await realpath(base);
  const skillDirectory = path.join(base, name);
  try {
    await mkdir(skillDirectory, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    throw new Error('A skill directory already exists at ' + skillDirectory + '; OASIS will not overwrite it.');
  }
  const info = await lstat(skillDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Skill destination is not a safe directory.');
  const resolvedSkill = await realpath(skillDirectory);
  if (!ensureInside(resolvedBase, resolvedSkill)) throw new Error('Skill destination resolves outside its managed directory.');
  return { skillDirectory, resolvedSkill };
}

async function skillDestination(root, scope, env) {
  if (normalizeScope(scope) === 'user') {
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const configHome = path.resolve(env.XDG_CONFIG_HOME || path.join(home, '.config'));
    const base = await ensureDirectoryChain(configHome, ['agents', 'skills']);
    const label = env.XDG_CONFIG_HOME
      ? path.join(configHome, 'agents', 'skills').split(path.sep).join('/')
      : '~/.config/agents/skills';
    return { base, path: label };
  }
  const workspace = await realpath(path.resolve(root));
  const base = await ensureDirectoryChain(workspace, ['.agents', 'skills']);
  return { base, path: '.agents/skills' };
}

export async function approveSkillProposal(root, id, { env = process.env } = {}) {
  const proposal = await getSkillProposal(root, id, { env });
  if (!proposal) throw new Error('No learning proposal matches ' + id + '.');
  if (proposal.status !== 'pending') throw new Error('Proposal ' + id + ' is already ' + proposal.status + '.');
  // Collision checks include bundled, imported, project, and user skills. A learned
  // skill must never silently shadow an existing skill from another source.
  const { listAvailableSkills } = await import('./tools.mjs');
  const existing = await listAvailableSkills(root, { env });
  if (existing.some((skill) => skill.name.toLowerCase() === proposal.name.toLowerCase())) {
    throw new Error('A skill named "' + proposal.name + '" already exists. Rename the proposal before promoting it.');
  }
  const destination = await skillDestination(root, proposal.scope, env);
  const { skillDirectory } = await createSkillDirectory(destination.base, proposal.name);
  const file = path.join(skillDirectory, 'SKILL.md');
  const markdown = [
    '---',
    'name: ' + proposal.name,
    'description: ' + JSON.stringify(proposal.description),
    '---',
    '',
    proposal.body.trim(),
    ''
  ].join('\n');
  try {
    await atomicWrite(file, markdown);
  } catch (error) {
    await rm(skillDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const promotedAt = new Date().toISOString();
  proposal.status = 'approved';
  proposal.updatedAt = promotedAt;
  proposal.promotedAt = promotedAt;
  proposal.promotedPath = path.join(destination.path, proposal.name, 'SKILL.md').split(path.sep).join('/');
  await persistProposal(proposal);
  return { id: proposal.id, name: proposal.name, scope: proposal.scope, status: proposal.status, path: proposal.promotedPath };
}

export async function rejectSkillProposal(root, id, reason = '', { env = process.env } = {}) {
  const proposal = await getSkillProposal(root, id, { env });
  if (!proposal) throw new Error('No learning proposal matches ' + id + '.');
  if (proposal.status !== 'pending') throw new Error('Proposal ' + id + ' is already ' + proposal.status + '.');
  const note = reason ? oneLine(validateTextWithoutSecrets('Rejection reason', reason, 500), 500) : 'Not promoted by the user.';
  proposal.status = 'rejected';
  proposal.updatedAt = new Date().toISOString();
  proposal.rejectionReason = note;
  await persistProposal(proposal);
  return { id: proposal.id, name: proposal.name, status: proposal.status, reason: note };
}

export function learningProposalText(proposal) {
  return [
    proposal.name + ' (' + proposal.id + ')',
    'Status: ' + proposal.status + ' · Scope: ' + proposal.scope,
    'Description: ' + proposal.description,
    'Evidence: ' + proposal.evidence,
    ...(proposal.promotedPath ? ['Promoted to: ' + proposal.promotedPath] : []),
    ...(proposal.rejectionReason ? ['Rejection: ' + proposal.rejectionReason] : []),
    '',
    proposal.body
  ].join('\n');
}

export const LEARNING_TOOL_DEFINITIONS = [{
  type: 'function',
  function: {
    name: 'skill_propose',
    description: 'Propose a reusable Agent Skill after a non-trivial task has actually succeeded and its relevant verification checks passed. Capture a repeatable procedure, not a one-off solution. Save to project scope by default; use user scope only for a broadly reusable preference or workflow that should follow this user across projects. This creates an inert pending proposal only: it does not activate, install, or overwrite a skill. The user must review it with /learning show ID and explicitly promote it with /learning approve ID.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase skill identifier, 2–49 letters/numbers/hyphens; starts with a letter.' },
        description: { type: 'string', description: 'One-sentence description, 12–180 characters.' },
        body: { type: 'string', description: 'Complete declarative Markdown skill body with Purpose, Inputs, Workflow, Required provider capabilities, Permissions, and Success criteria headings. Do not include front matter or executable scripts.' },
        evidence: { type: 'string', description: 'Brief evidence: what worked, changed files, and relevant passing check. Do not claim a check passed unless a tool result proves it.' },
        scope: { type: 'string', enum: ['project', 'user'], description: 'Defaults to project. User scope is shared across this user’s projects.' }
      },
      required: ['name', 'description', 'body', 'evidence'],
      additionalProperties: false
    }
  }
}];

export async function runLearningTool(name, args = {}, context = {}) {
  if (name !== 'skill_propose') throw new Error('Unknown learning tool: ' + name);
  return await createSkillProposal(context.root || process.cwd(), args, {
    env: context.env || process.env,
    session: context.session || null
  });
}
