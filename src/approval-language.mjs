/**
 * Plain-language descriptions for actions that need user approval.
 *
 * This module deliberately has no terminal or browser dependencies so the CLI
 * and browser workspace can use the same wording. It redacts common credential
 * formats before text is shown in an approval card or copied into logs.
 */
export function redactApprovalSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted secret]')
    .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?)[^\s"'\x60,;]+/gi, '$1[redacted]')
    .replace(/(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|token)\b\s*[:=]\s*["']?)[^"'\s,;]+/gi, '$1[redacted]');
}

function safeLabel(value, fallback = 'the requested item') {
  const text = redactApprovalSecrets(String(value == null ? '' : value).replace(/[\r\n\0]/g, ' ').trim()).slice(0, 500);
  return text ? '“' + text + '”' : fallback;
}

function inputValue(input, key) {
  return input && typeof input === 'object' && typeof input[key] === 'string' ? input[key] : '';
}

export function formatApprovalMessage(prompt, meta = {}) {
  const original = redactApprovalSecrets(String(prompt == null ? '' : prompt).trim()).slice(0, 3500);
  const tool = String(meta && meta.tool || '').toLowerCase();
  const input = meta && meta.input && typeof meta.input === 'object' ? meta.input : {};
  const path = inputValue(input, 'path');
  const command = [inputValue(input, 'command'), ...(Array.isArray(input.args) ? input.args.filter((arg) => typeof arg === 'string') : [])].filter(Boolean).join(' ');
  let message = '';
  let risky = false;

  if (tool === 'delete_file' || /^delete (?:the workspace )?file\b/i.test(original)) {
    const match = original.match(/^Delete the workspace file\s+(.+?)\?\s*/i);
    const target = path || (match && match[1]) || '';
    message = 'OASIS wants to delete the file ' + safeLabel(target) + '. A backup will be made first, but the file will be removed from your project. Approve only if that is what you intended.';
    risky = true;
  } else if (tool === 'write_file' || tool === 'edit_file' || tool === 'multi_edit' || /^(?:write|edit|update|replace) (?:the )?(?:workspace )?file\b/i.test(original)) {
    const match = original.match(/^(?:write|edit|update|replace) (?:the )?(?:workspace )?file\s+(.+?)(?:\?|$)/i);
    const target = path || (match && match[1]) || '';
    const action = tool === 'write_file' ? 'create or replace' : 'change';
    message = 'OASIS wants to ' + action + ' the file ' + safeLabel(target) + '. Review the proposed change before approving it.';
  } else if (tool === 'run_command' || tool === 'run_shell' || tool === 'powershell' || /^Run this command in the workspace\?/i.test(original)) {
    const match = original.match(/^Run this command in the workspace\?\s*\n\s*([^\n]+)/i);
    const commandText = command || (match && match[1].trim()) || '';
    message = 'OASIS wants to run this command in your project:\n  ' + (commandText ? redactApprovalSecrets(commandText).slice(0, 1200) : '[command details shown below]') +
      '\nCommands can change project files or run project scripts. Read the command before you approve it.';
    risky = /\b(?:sudo|su\s+-|rm\s+-rf|mkfs(?:\.|\s)|diskpart|format\s+[a-z]:|shutdown|reboot|drop\s+(?:database|table)|chmod\s+-R\s+777|curl\b[^\n]*\|\s*(?:sh|bash))\b/i.test(commandText);
    if (/HIGH RISK:/i.test(original)) risky = true;
  } else if (/^Install package\s+/i.test(original)) {
    const match = original.match(/^Install package\s+(.+?)\s+using\s+(.+?)(?:\n|$)/i);
    message = 'OASIS wants to install package ' + safeLabel(match && match[1]) +
      (match && match[2] ? ' by running ' + safeLabel(match[2]) : '') +
      '. This changes your environment and may run third-party installer code. Approve only if you trust the package and source.';
    risky = true;
  } else if (/^Install(?:\/update)? Oasis\b/i.test(original) || /^Install the reviewed Oasis plugin bundle\b/i.test(original)) {
    message = 'OASIS wants to install or update project software. This changes files or dependencies and may run code. Review the source and the requested action before approving it.';
    risky = true;
  } else {
    const normalized = original.replace(/\s+/g, ' ').slice(0, 1800);
    message = 'OASIS is asking permission to take this action:\n' + (normalized || 'The action details were not provided.');
    risky = /\b(?:delete|remove|install|uninstall|overwrite|cannot be undone|high risk|format|drop database|sudo|rm\s+-rf)\b/i.test(original);
  }

  if (risky) message = 'WARNING — RISKY ACTION\n' + message;
  return { message, risky };
}
