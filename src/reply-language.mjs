// Reply language (Claude Code's "language" setting, OASIS_LANGUAGE, or /language).
// Pins the language of the agent's own prose so replies do not drift into the
// language of a file, log or web page it just read.

const BLOCK = /\n*<reply-language>[\s\S]*?<\/reply-language>/g;

export function replyLanguageBlock(language) {
  return '<reply-language>\nAlways write your replies, plans, questions and summaries in ' + language +
    ', even when files, tool output or web pages use another language. Keep code, identifiers, commands, file paths and quoted text unchanged.\n</reply-language>';
}

/** Returns the system prompt with any earlier language block replaced (or removed when language is null). */
export function withReplyLanguage(systemText, language) {
  const base = String(systemText || '').replace(BLOCK, '');
  return language ? base + '\n\n' + replyLanguageBlock(language) : base;
}

/** Applies a language to a live session's system prompt. */
export function applyReplyLanguage(session, language) {
  session.language = language || null;
  for (const key of ['baseSystemPrompt', 'mcpSystemPromptBase']) {
    if (typeof session[key] === 'string') session[key] = withReplyLanguage(session[key], language);
  }
  if (session.messages && session.messages[0] && session.messages[0].role === 'system' && typeof session.messages[0].content === 'string') {
    session.messages[0].content = withReplyLanguage(session.messages[0].content, language);
  }
}
