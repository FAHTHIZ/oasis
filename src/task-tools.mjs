// task_contract: the model-facing side of the universal task model
// (src/task-model.mjs). The model can read the contract OASIS derived from
// the request, add deliverables, criteria and constraints it missed, and see
// how the criteria stand against the evidence so far. It cannot mark a
// criterion met or set the outcome: those come from tool results.
import { currentReviews } from './task-reviews.mjs';
import { evidenceSince, sessionEvidence } from './evidence-ledger.mjs';
import { assessOutcome, declareOnSpec, deriveTaskSpec, specSummary, CRITERION_KINDS } from './task-model.mjs';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const TASK_TOOL_DEFINITIONS = [
  fn('task_contract', 'Read or refine the task contract OASIS derived from the user\'s request: intent, domains, risk, deliverables and acceptance criteria that are checked against tool results before you finish. action "show" returns it; "status" evaluates every criterion against the evidence so far (met, unmet or unknown, with why); "declare" adds deliverables, criteria or constraints the request implies but OASIS missed. You cannot mark criteria met or remove them; OASIS evaluates them. Declare only what the user asked for.',
    {
      action: { type: 'string', enum: ['show', 'status', 'declare'] },
      deliverables: { type: 'array', maxItems: 10, items: { type: 'object', properties: {
        kind: { type: 'string', enum: ['file', 'code_change', 'report', 'dataset', 'plan', 'document', 'action', 'answer'] },
        description: { type: 'string', maxLength: 240 },
        path: { type: 'string', description: 'Workspace-relative path of a file deliverable' }
      }, required: ['description'], additionalProperties: false } },
      acceptance: { type: 'array', maxItems: 15, items: { type: 'object', properties: {
        kind: { type: 'string', enum: CRITERION_KINDS.filter((kind) => kind !== 'independent_review') },
        description: { type: 'string', maxLength: 240 },
        command: { type: 'string', description: 'check_passes: the check that must pass after the last edit' },
        path: { type: 'string', description: 'file_exists: the file; word_limit: the file to measure (default: your reply)' },
        contains: { type: 'string', description: 'file_exists: text the file must contain' },
        min: { type: 'integer', minimum: 1 },
        max: { type: 'integer', minimum: 1 },
        unit: { type: 'string', enum: ['word', 'sentence', 'bullet', 'paragraph', 'line', 'character'] },
        independent: { type: 'boolean', description: 'cites_sources: sources must be independent of each other' }
      }, required: ['kind', 'description'], additionalProperties: false } },
      constraints: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 240 } }
    }, ['action'])
];

export const TASK_TOOL_NAMES = new Set(TASK_TOOL_DEFINITIONS.map((tool) => tool.function.name));

function currentSpec(session) {
  if (session.task) return session.task;
  // No contract yet (task model off for the turn, or a subagent): derive one
  // from the current request so the tool still answers.
  return deriveTaskSpec(session.currentRequest || '', { source: 'user' });
}

export function runTaskTool(session, name, args = {}) {
  if (name !== 'task_contract') throw new Error('Unknown task tool ' + name);
  const action = String(args.action || 'show');
  const spec = currentSpec(session);
  if (action === 'show') return { task: specSummary(spec) };
  if (action === 'status') {
    const events = evidenceSince(sessionEvidence(session), session.taskEvidenceFrom || 0);
    const outcome = assessOutcome(spec, { events, reply: '', root: session.root, ...reviewContext(session) });
    return {
      task: spec.id,
      // Claims are judged on the final answer, which does not exist yet.
      criteria: outcome.acceptance.criteria.filter((item) => item.kind !== 'claims_supported').map(({ id, kind, description, status, detail }) => ({ id, kind, description, status, ...(detail ? { detail } : {}) })),
      note: 'Status is computed from tool results so far; claims in your answer are checked when you finish.'
    };
  }
  if (action === 'declare') {
    const { spec: next, added, errors } = declareOnSpec(spec, args);
    if (!added.length && !errors.length && !(Array.isArray(args.constraints) && args.constraints.length)) throw new Error('declare needs deliverables, acceptance or constraints.');
    session.task = next;
    return { task: next.id, added, ...(errors.length ? { errors } : {}), acceptance: next.acceptance.map(({ id, kind, description, source }) => ({ id, kind, description, source })) };
  }
  throw new Error('task_contract action must be show, status or declare.');
}

function reviewContext(session) {
  const { current, stale } = currentReviews(session);
  return { reviews: current, staleReviews: stale.length };
}
