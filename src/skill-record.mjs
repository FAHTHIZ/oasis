// Skill track records: how tasks that used a skill actually turned out.
//
// A skill is a procedure the model follows. Whether following it works is
// not something the skill can say about itself, and finishing a task while
// using it is not success. So each time a turn ends with a task outcome
// (src/task-model.mjs), every skill loaded for that task is credited with the
// outcome's verdict, keyed by the skill's content digest: an edited skill
// starts a new record, and the old one is kept for comparison.
//
//   success   verified, independently_verified
//   failure   rejected, failed, incomplete
//   neutral   unverified, evidenced, cancelled (nothing decisive was learned)
//
// When the skill is loaded again, its record rides along with the
// instructions: how often tasks that followed it were verified, how often
// they were rejected and why. A version that keeps failing is flagged, so the
// model checks its steps against the task instead of trusting them.
//
// Records live in <config>/skill-record.json (mode 0600). Only skill names,
// digests, verdicts, a short reason and an opaque project key are stored.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.mjs';
import { getConfigDirectory } from './config.mjs';
import { wilsonLower } from './agent-experience.mjs';

export const SKILL_RECORD_VERSION = 1;
const MAX_RUNS_PER_VERSION = 40;
const MAX_VERSIONS_PER_SKILL = 5;
const MAX_SKILLS = 300;
const SUCCESS = new Set(['verified', 'independently_verified']);
const FAILURE = new Set(['rejected', 'failed', 'incomplete']);

export function skillRecordEnabled(env = process.env, settings = null) {
  if (settings && settings.skillRecord === false) return false;
  return !/^(0|false|off|no)$/i.test(String(env.OASIS_SKILL_RECORD || ''));
}

export function skillRecordFile(env = process.env) {
  if (env.OASIS_SKILL_RECORD_FILE) return path.resolve(env.OASIS_SKILL_RECORD_FILE);
  return path.join(getConfigDirectory(env), 'skill-record.json');
}

export function skillDigest(content) {
  return createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
}

function projectKey(root) {
  return root ? createHash('sha256').update(path.resolve(String(root))).digest('hex').slice(0, 12) : '';
}

export function verdictClass(verdict) {
  return SUCCESS.has(verdict) ? 'success' : FAILURE.has(verdict) ? 'failure' : 'neutral';
}

function emptyStore() {
  return { version: SKILL_RECORD_VERSION, skills: {} };
}

export function readSkillRecords(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(skillRecordFile(env), 'utf8'));
    if (!parsed || parsed.version !== SKILL_RECORD_VERSION || typeof parsed.skills !== 'object' || !parsed.skills) return emptyStore();
    return parsed;
  } catch { return emptyStore(); }
}

async function writeSkillRecords(store, env) {
  const file = skillRecordFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(store, null, 1) + '\n', { mode: 0o600 });
  try { await chmod(file, 0o600); } catch {}
}

/**
 * Notes that a skill was loaded for the session's current task. Called with
 * the first chunk of the skill's instructions.
 */
export function noteSkillUse(session, name, content) {
  if (!session || typeof session !== 'object' || !name) return null;
  const taskId = session.task && session.task.id || '';
  const use = { name: String(name).slice(0, 120), digest: skillDigest(content), taskId };
  if (!Array.isArray(session.taskSkills)) session.taskSkills = [];
  if (!session.taskSkills.some((item) => item.name === use.name && item.digest === use.digest && item.taskId === taskId)) session.taskSkills.push(use);
  if (session.taskSkills.length > 30) session.taskSkills.splice(0, session.taskSkills.length - 30);
  return use;
}

/**
 * Credits the outcome of the session's task to every skill loaded for it.
 * The key (task id and turn) makes a re-assessment of the same turn replace
 * its earlier entry rather than count twice. Returns the skills updated.
 */
export async function recordSkillOutcomes(session, outcome, { env = process.env, now = Date.now() } = {}) {
  if (!session || !outcome || !outcome.verdict || !skillRecordEnabled(env, session.settings)) return [];
  const taskId = session.task && session.task.id || '';
  const uses = (Array.isArray(session.taskSkills) ? session.taskSkills : []).filter((use) => use.taskId === taskId);
  if (!uses.length) return [];
  const key = (session.sessionId || 'unsaved') + ':' + taskId + ':' + (session.task && session.task.turns || 1);
  const reason = outcomeReason(outcome);
  const store = readSkillRecords(env);
  for (const use of uses) {
    const skill = store.skills[use.name] ||= { versions: {} };
    const version = skill.versions[use.digest] ||= { firstSeen: now, runs: [] };
    version.runs = version.runs.filter((run) => run.key !== key);
    version.runs.push({ key, verdict: outcome.verdict, class: verdictClass(outcome.verdict), at: now, project: projectKey(session.root), ...(reason ? { reason } : {}) });
    if (version.runs.length > MAX_RUNS_PER_VERSION) version.runs.splice(0, version.runs.length - MAX_RUNS_PER_VERSION);
    version.lastUsed = now;
    skill.current = use.digest;
    skill.lastUsed = now;
    const digests = Object.keys(skill.versions).sort((a, b) => (skill.versions[b].lastUsed || 0) - (skill.versions[a].lastUsed || 0));
    for (const stale of digests.slice(MAX_VERSIONS_PER_SKILL)) delete skill.versions[stale];
  }
  const names = Object.keys(store.skills).sort((a, b) => (store.skills[b].lastUsed || 0) - (store.skills[a].lastUsed || 0));
  for (const stale of names.slice(MAX_SKILLS)) delete store.skills[stale];
  try { await writeSkillRecords(store, env); } catch { return []; }
  return uses.map((use) => use.name);
}

function outcomeReason(outcome) {
  if (verdictClass(outcome.verdict) !== 'failure') return '';
  const issue = outcome.claims && Array.isArray(outcome.claims.issues) && outcome.claims.issues[0];
  if (issue && issue.reason) return String(issue.reason).slice(0, 160);
  const unmet = outcome.acceptance && Array.isArray(outcome.acceptance.criteria) && outcome.acceptance.criteria.find((item) => item.status === 'unmet');
  if (unmet) return String(unmet.description + (unmet.detail ? ' (' + unmet.detail + ')' : '')).slice(0, 160);
  if (outcome.independent && outcome.independent.verdict === 'fail') return 'independent review failed';
  return outcome.execution && outcome.execution !== 'completed' ? 'run ' + outcome.execution : '';
}

/** Aggregate one version's runs. */
export function summarizeRuns(runs = []) {
  const summary = { runs: runs.length, success: 0, failure: 0, neutral: 0, lastFailure: null };
  for (const run of runs) {
    summary[run.class === 'success' ? 'success' : run.class === 'failure' ? 'failure' : 'neutral'] += 1;
    if (run.class === 'failure' && (!summary.lastFailure || run.at > summary.lastFailure.at)) summary.lastFailure = run;
  }
  const decisive = summary.success + summary.failure;
  summary.decisive = decisive;
  summary.successRate = decisive ? summary.success / decisive : null;
  summary.successLowerBound = wilsonLower(summary.success, decisive);
  // Failing more often than not across at least three decisive runs, or the
  // last three decisive runs all failed.
  const recent = runs.filter((run) => run.class !== 'neutral').slice(-3);
  summary.flagged = (decisive >= 3 && summary.failure > summary.success) || (recent.length === 3 && recent.every((run) => run.class === 'failure'));
  return summary;
}

/** The record of a skill as it is now (digest of its content) and before. */
export function skillTrackRecord(name, content, { env = process.env, store = null } = {}) {
  const records = store || readSkillRecords(env);
  const skill = records.skills[String(name || '')];
  if (!skill) return null;
  const digest = skillDigest(content);
  const current = skill.versions[digest] ? summarizeRuns(skill.versions[digest].runs) : null;
  const previous = Object.entries(skill.versions).filter(([key]) => key !== digest).map(([, version]) => version.runs).flat();
  return { name, digest, current, previous: previous.length ? summarizeRuns(previous) : null };
}

/**
 * The note that rides along with a loaded skill, or '' when it has no
 * decisive history. Labelled as a record of outcomes, not instructions.
 */
export function skillRecordNote(record) {
  if (!record) return '';
  const { current, previous } = record;
  if (current && current.decisive) {
    let note = 'Track record of this skill version (OASIS-checked task outcomes, not instructions): ' + current.success + ' of ' + current.decisive + ' decisive task(s) that followed it were verified, ' + current.failure + ' rejected or failed';
    if (current.neutral) note += ', ' + current.neutral + ' not checkable';
    note += '.';
    if (current.lastFailure && current.lastFailure.reason) note += ' Last failure: ' + current.lastFailure.reason + '.';
    if (current.flagged) note += ' Tasks that follow this version fail more often than not: check each step against this task and the current code before relying on it, and say so if a step is wrong.';
    return note;
  }
  if (previous && previous.decisive) {
    return 'This skill changed since it was last used. Earlier versions (OASIS-checked task outcomes): ' + previous.success + ' of ' + previous.decisive + ' decisive task(s) verified. This version has no record yet.';
  }
  return '';
}

/** Rows for a listing (`/skills record`): every skill's current version. */
export function skillRecordRows({ env = process.env } = {}) {
  const store = readSkillRecords(env);
  return Object.entries(store.skills).map(([name, skill]) => {
    const version = skill.versions[skill.current] || Object.values(skill.versions)[0];
    const summary = summarizeRuns(version ? version.runs : []);
    return { name, digest: skill.current || '', versions: Object.keys(skill.versions).length, lastUsed: skill.lastUsed || 0, ...summary };
  }).sort((a, b) => b.lastUsed - a.lastUsed);
}

export function formatSkillRecordRows(rows) {
  if (!rows.length) return 'No skill has been used in a task with a checked outcome yet.';
  return rows.map((row) => {
    const rate = row.decisive ? Math.round(row.successRate * 100) + '% verified of ' + row.decisive + ' decisive' : 'no decisive runs';
    return '- ' + row.name + ': ' + row.runs + ' task(s), ' + rate + (row.failure ? ', ' + row.failure + ' failed' : '') + (row.flagged ? ' [flagged]' : '') + (row.versions > 1 ? ' (' + row.versions + ' versions)' : '') + (row.lastFailure && row.lastFailure.reason ? '\n    last failure: ' + row.lastFailure.reason : '');
  }).join('\n');
}
