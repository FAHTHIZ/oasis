// Session commands shared by every chat gateway (Hermes parity): /model, /effort, /compact
// (/compress), /usage, /context, /insights, /undo, /retry, /skills and /<skill-name>.
// They reuse the terminal's built-in implementations, so a chat behaves like the REPL.
//
// sharedChatCommand returns null when the command is not one of these, otherwise
// { text } to send back, or { prompt } to run as the next turn (/retry, /<skill>).

const READ_ONLY = new Set(['usage', 'cost', 'context', 'insights', 'skills']);
const MUTATING = new Set(['model', 'effort', 'compact', 'undo', 'fast']);
const ALIASES = { compress: 'compact', reset: 'new', tokens: 'usage' };

export const CHAT_COMMAND_HELP = '/model [NAME] switches the model, /effort LEVEL sets reasoning, /compress shrinks the context, /usage shows tokens and cost, /insights summarizes recent sessions, /undo removes the last turn, /retry runs the last request again, /skills lists skills and /SKILL-NAME uses one.';

function lastUserText(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i > 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const content = Array.isArray(message.content) ? message.content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n') : String(message.content || '');
    // Tool results and injected reminders are user-role too; skip anything that is not a typed request.
    if (content.trim() && !/^<(?:system-reminder|tool_result|task-notification)/.test(content.trim())) return content;
  }
  return '';
}

/**
 * @param {string} cmd  lower-case command without the leading / or !
 * @param {string} argument
 * @param {{ state: object|null, ensureState: () => Promise<object>, root: string, env: object, runBuiltin?: Function, resolveSkill?: Function }} context
 */
export async function sharedChatCommand(cmd, argument, context) {
  const name = ALIASES[cmd] || cmd;
  if (name === 'new') return null;
  const { root, env } = context;
  if (name === 'retry') {
    const state = context.state;
    if (!state || !state.session) return { text: 'Nothing to retry yet.' };
    if (state.controller) return { text: 'Still working on the previous request. Send /stop first.' };
    const text = lastUserText(state.session);
    if (!text) return { text: 'Nothing to retry yet.' };
    const runBuiltin = context.runBuiltin || (await import('./slash.mjs')).runBuiltinCommand;
    // Remove the last exchange from the conversation only; edits it made stay (use /undo for those).
    await runBuiltin('rewind', '1 chat', { root, env, session: state.session, sessionOptions: {} }).catch(() => null);
    return { prompt: text, text: 'Retrying: ' + (text.length > 80 ? text.slice(0, 77) + '...' : text) };
  }
  if (READ_ONLY.has(name) || MUTATING.has(name)) {
    let state = context.state;
    if (MUTATING.has(name)) {
      if (state && state.controller) return { text: 'Still working on the previous request. Send /stop first.' };
      if (name !== 'undo' && name !== 'compact') state = await context.ensureState();
    }
    if ((name === 'undo' || name === 'compact') && !state) return { text: name === 'undo' ? 'Nothing to undo yet.' : 'Nothing to compact yet.' };
    const runBuiltin = context.runBuiltin || (await import('./slash.mjs')).runBuiltinCommand;
    // In a chat, /compress compacts at once instead of showing a preview to confirm.
    if (name === 'compact' && !/^(undo|cancel|confirm|preserve)\b/i.test(argument)) {
      await runBuiltin('compact', argument, { root, env, session: state.session, sessionOptions: {}, headless: true });
      argument = 'confirm';
    }
    const result = await runBuiltin(name, argument, { root, env, session: state && state.session, sessionOptions: {}, usage: state && state.session && state.session.chatUsage, headless: true });
    let text = String(result && result.output || 'Done.');
    if (result && result.prompt) return { prompt: result.prompt, text: text === 'Done.' ? '' : text };
    if (text.length > 3800) text = text.slice(0, 3800) + '\n...';
    return { text };
  }
  // /<skill-name> [request]
  if (/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    const resolveSkill = context.resolveSkill || (await import('./commands.mjs')).resolveSkillCommand;
    const skill = await resolveSkill(root, '/' + name + (argument ? ' ' + argument : ''), { env }).catch(() => null);
    if (skill) {
      const prompt = skill.options && skill.options.fork ? 'Use the task tool with subagent_type "' + (skill.options.fork.agent || 'general-purpose') + '" to run this, then report its result:\n\n' + skill.prompt : skill.prompt;
      return { prompt, text: '' };
    }
  }
  return null;
}

/** Token and cost tracking for a chat's session, so /usage reports real numbers. Call once per turn. */
export async function chatUsageRecorder(session) {
  const { createUsageTracker, recordUsage } = await import('./slash.mjs');
  if (!session.chatUsage) session.chatUsage = createUsageTracker();
  session.chatUsage.turns += 1;
  return (usage) => { try { recordUsage(session.chatUsage, usage); } catch { /* never break a turn over accounting */ } };
}
