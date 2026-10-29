# Slash commands and portable workflow skills

OASIS keeps a small set of explicit engineering workflows on top of the existing slash-command registry and Agent Skills loader. The agent loop, provider adapters, tool policy, and session model are not replaced.

## Core workflows

| Command | Skill | Behavior | Side effects |
|---|---|---|---|
| `/init [focus]` | `skills/init/SKILL.md` | Inspect the project and create or carefully merge `OASIS.md` based on repository evidence. | File edits go through existing workspace tools and approval/snapshot protections. |
| `/plan TASK` | `skills/plan/SKILL.md` | Inspect relevant code and tests; return ordered steps, risks, and verification. | Plan-only runtime; no edits or project commands. |
| `/fix BUG` | `skills/debugging/SKILL.md` | Reproduce, diagnose, fix minimally, and verify one bug. | Existing approvals and snapshot/file-state protections apply. |
| `/diagnose INPUT` | `skills/diagnose/SKILL.md` | Analyze a log, error, failing output, path, or screenshot. | Read-only by default. It will not attempt a fix. |
| `/review [target]` | `skills/code-review/SKILL.md` | Review the working diff or target for concrete bugs and security, performance, accessibility, and test gaps. | Read-only unless the existing `--fix` option is explicit. |
| `/rollback` | `skills/rollback/SKILL.md` | Preview the latest file checkpoint and list affected paths. | Preview only. |
| `/rollback confirm` | `skills/rollback/SKILL.md` | Restore that exact checkpoint after revalidating it. | Saves current file contents to the local recovery-backup store before restore. |

Commands with required input show usage text and do not start an agent turn when the input is missing. Each workflow prints a short action preview before handing the task to the agent.

## Portable skill format

Use the existing `skills/NAME/SKILL.md` layout with front matter:

```yaml
---
name: skill-name
description: One focused, repeatable workflow.
---
```

The body must define `Purpose`, `Inputs`, `Workflow`, `Required provider capabilities`, `Permissions`, and `Success criteria`. Keep skill files declarative Markdown; tools and enforcement remain in the OASIS runtime. Do not place scripts, credentials, or provider-specific API code in a portable skill.

## Provider capability honesty

All skills use text reasoning and tool calling as their baseline capabilities. File reading, editing, command execution, and image input are conditional and are not assumed just because a provider is configured.

Image support is tri-state: `supported`, `unsupported`, or `unknown`. Recognized model-family names are a best-effort hint, not a guarantee; an API-level rejection is stronger evidence. `OASIS_VISION=off` or `vision: false` disables image input. `OASIS_MODEL_VISION=on|off` provides an explicit operator override for the capability preflight. When image support is unknown or unsupported, diagnosis must say it cannot reliably inspect the image and request text or an appropriate model.

## Safety boundary

- The skills are instructions, not an authorization system. Existing runtime permission checks remain authoritative.
- File writes and edits continue through normal workspace tools, path checks, stale-file checks, and snapshots.
- Installs, command executions, and network requests require existing approvals and policy checks; prompts in a skill never grant permission.
- Rollback is two-step. The preview itself makes no changes; `/rollback confirm` is rejected if the latest checkpoint differs from the preview.
- Before restoring, eligible current files are saved with `snapshotFile` in the OASIS local recovery-backup store.
- Checkpoints only capture file operations registered by the file-tool checkpoint system. Shell-command side effects, installs, network activity, and external changes are not reversed.
- A successful file-only rollback leaves conversation history intact and consumes the restored checkpoint so it is not replayed accidentally.

## Minimal UI behavior

The terminal shows a compact suggestion list while typing a slash-command name; Tab completion remains available. The browser displays the six core workflows when the input starts with `/`. Selecting an item only inserts the command—it does not run it. The description includes the scope (read-only, edits after approval, or explicit restore confirmation). Existing command palettes and keybindings remain in place.

## Tests

Run `npm test` for focused and broader Node tests, and `npm run check` for the repository's validation pipeline. The skill-command test file covers registry entries, missing inputs, plan-only routing, screenshot capability disclosure, rollback preview immutability, pre-restore recovery snapshots, and stale-preview rejection.
