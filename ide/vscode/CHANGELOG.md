# Changelog

Notable user-facing changes to the OASIS VS Code integration are recorded here.

## 0.2.0

- Add the OASIS activity-bar chat panel and commands for opening or starting chats.
- Share the active editor selection and file context with OASIS.
- Support proposed-edit review through native VS Code diff views.
- Add commands for terminal handoff, continuing a session, inserting file references, and closing proposed diffs.
- Add workspace bridge lifecycle handling and keyboard shortcuts.

## Unreleased

- Marketplace screenshots and a marketplace-ready PNG extension icon still need to be prepared and checked before publishing.
- Permission cards now use “Allow once” and “Deny”, explain that the requested action should be reviewed, and add warning styling for likely destructive requests. Reusable rules remain explicitly scoped to the current session.
- Nonzero CLI exits now show a plain-language next step and an `oasis doctor` hint; stack-frame lines are omitted from the short error summary.
- Approval buttons have visible keyboard-focus styling and a larger click target. Manual review of exact wording and allow-rule scope is still needed in a live VS Code session.
