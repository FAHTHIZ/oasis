// The ask_user_question tool: question shape, answer resolution and the
// per-turn question budget.

// Users report agents halting mid-task to ask several obvious questions per
// turn. Cap interactive questions per turn (default 2); further calls tell the
// model to decide and state its assumption. OASIS_MAX_QUESTIONS_PER_TURN or
// config.maxQuestionsPerTurn overrides; "off"/"unlimited" removes the cap.
export function questionBudget(session, options = {}) {
  const env = options.env || process.env;
  const raw = env.OASIS_MAX_QUESTIONS_PER_TURN !== undefined && env.OASIS_MAX_QUESTIONS_PER_TURN !== ''
    ? env.OASIS_MAX_QUESTIONS_PER_TURN
    : session && session.config && session.config.maxQuestionsPerTurn;
  if (raw === undefined || raw === null || raw === '') return 2;
  if (/^(off|unlimited|none|false)$/i.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 2;
}

// Display bounds only. They used to be 600 / 80 / 300 characters, and the
// user's typed answer was cut at 2,000 with no note, so a pasted spec or a
// long explanation reached the model half-finished. An answer has the same
// bound as a steering message (MAX_STEER_CHARS).
const MAX_QUESTION_CHARS = 4000;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 200_000;

export const ASK_USER_TOOL_DEFINITION = { type: 'function', function: {
  name: 'ask_user_question',
  description: 'Ask the user a multiple-choice question when a decision really changes the work. Options may be strings or objects with a label and optional description. Not for permission or things you can find out yourself.',
  parameters: { type: 'object', properties: {
    question: { type: 'string', description: 'One clear question ending with a question mark' },
    header: { type: 'string', description: 'Very short label, up to 12 characters' },
    options: { type: 'array', minItems: 2, maxItems: 4, items: { oneOf: [
      { type: 'string', minLength: 1 },
      { type: 'object', properties: {
        label: { type: 'string', minLength: 1, description: '1-5 word choice' },
        description: { type: 'string', description: 'What this choice means or its trade-off' }
      }, required: ['label'], additionalProperties: false }
    ] } },
    multiSelect: { type: 'boolean', description: 'Allow choosing several options' }
  }, required: ['question', 'options'] }
} };

export function normalizeQuestion(args = {}) {
  const question = String(args.question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new Error('ask_user_question needs a question.');
  const options = (Array.isArray(args.options) ? args.options : []).slice(0, 4).map((item) => typeof item === 'string'
    ? { label: item.trim().slice(0, MAX_LABEL_CHARS), description: '' }
    : { label: String(item && item.label || '').trim().slice(0, MAX_LABEL_CHARS), description: String(item && item.description || '').trim().slice(0, MAX_DESCRIPTION_CHARS) }).filter((item) => item.label);
  if (options.length < 2) throw new Error('ask_user_question needs 2-4 options.');
  return { question, header: String(args.header || '').trim().slice(0, 12), options, multiSelect: Boolean(args.multiSelect) };
}

// Multiple-choice question from the agent: answer with numbers or type freely.
export function resolveQuestionAnswer(question, raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const picks = text.split(/[\s,]+/);
  if (picks.every((item) => /^\d+$/.test(item) && Number(item) >= 1 && Number(item) <= question.options.length)) {
    const chosen = [...new Set(picks.map(Number))].map((index) => question.options[index - 1].label);
    return (question.multiSelect ? chosen : chosen.slice(0, 1)).join(', ');
  }
  return text;
}

export async function askUserQuestion(session, args, options) {
  const question = normalizeQuestion(args);
  if (typeof options.askUser !== 'function') {
    return { answered: false, message: 'No user is available to answer (non-interactive run). Choose the most reasonable option, state the assumption in your reply, and continue.' };
  }
  const answer = await options.askUser(question);
  if (answer === null || answer === undefined || String(answer).trim() === '') {
    return { answered: false, message: 'The user did not answer. Pick the safest reasonable option, say which one you picked, and continue.' };
  }
  return { answered: true, question: question.question, answer: String(answer).slice(0, MAX_ANSWER_CHARS) };
}
