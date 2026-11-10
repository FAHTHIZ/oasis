import { redactApprovalSecrets } from '../src/approval-language.mjs';

/** Show a readable error with an explicit way to copy redacted diagnostics. */
export async function showErrorWithCopy({ dialog, clipboard, window, type = 'error', title, message, detail = '' }) {
  const safeDetail = redactApprovalSecrets(String(detail || ''));
  const safeTitle = redactApprovalSecrets(String(title || 'OASIS needs attention'));
  const safeMessage = redactApprovalSecrets(String(message || 'Something went wrong.'));
  const details = [safeTitle, safeMessage, safeDetail].filter(Boolean).join('\n\n');
  const options = {
    type,
    title: safeTitle,
    message: safeMessage,
    detail: safeDetail,
    buttons: ['Copy details', 'Close'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (result && result.response === 0) {
    try {
      clipboard.writeText(details);
      return { copied: true };
    } catch {
      const fallbackOptions = {
        type: 'warning',
        title: 'Could not copy details',
        message: 'OASIS could not copy the diagnostic text. You can select and copy the error details manually.',
        detail: safeDetail,
        buttons: ['Close'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      };
      if (window) await dialog.showMessageBox(window, fallbackOptions);
      else await dialog.showMessageBox(fallbackOptions);
    }
  }
  return { copied: false };
}
