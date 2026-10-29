---
name: rollback
description: Preview and restore the latest OASIS-tracked file checkpoint with recovery backups and explicit confirmation.
---

# Purpose
Restore file state from the latest eligible OASIS checkpoint without silently discarding the current contents or rewriting the conversation.

## Inputs
- An active OASIS session with a file checkpoint
- The latest checkpoint preview
- The user's explicit second-step confirmation: /rollback confirm

## Workflow
1. Preview the latest checkpoint, its originating task, tracked paths, and limitations. Do not change files during preview.
2. Require the user to submit /rollback confirm after reading the preview.
3. Confirm the checkpoint has not changed since the preview.
4. Save the current contents of every eligible existing file to the existing local recovery-backup store before restoration.
5. Restore only the file state captured by the latest eligible checkpoint. Do not delete or rewrite conversation history.
6. Report restored, deleted, and skipped paths, and identify the recovery backup records created.
7. Explain that shell-command side effects, network operations, installs, and changes not captured by file tools are not reversed by this checkpoint operation.

## Required provider capabilities
- None for the deterministic restore operation; it is handled by OASIS runtime code
- File-system access restricted to the active workspace and OASIS's recovery store

## Permissions
- Preview is read-only.
- Restoration requires explicit /rollback confirm after the preview.
- Use existing workspace path validation and reject unsafe destinations and symbolic links.
- Preserve current file contents in the recovery store before restoration.
- Do not execute shell commands, contact the network, or attempt to undo external side effects.

## Success criteria
- No files change until confirmation.
- The confirmed checkpoint is still the latest checkpoint.
- Current eligible files are backed up before restore.
- Restoration results, skipped paths, and limitations are reported truthfully.
