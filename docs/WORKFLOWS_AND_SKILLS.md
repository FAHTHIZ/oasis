# OASIS workflows, slash commands and skills

This is the canonical reference for the user-facing command/workflow model and portable skills. Runtime permissions and tool enforcement remain authoritative; Markdown skill instructions never grant capabilities.

## Design goal

OASIS should feel like a fast engineering workbench, not a chatbot wrapped in a dashboard. The slash-command interaction is the front door to six dependable workflows. Keep the UI quiet when the developer is writing prose, expose commands at the moment they are useful, and make risky behavior legible before an agent tool acts.

This document scopes design decisions for the slash-command and skills system, not a new application-wide visual framework.

## Interaction contract

1. Typing / at the start of the composer reveals exactly six primary workflows.
2. The list is filter-as-you-type, anchored close to the composer, and short enough to scan without obscuring the conversation.
3. Every item has a stable command name, action-oriented description, and permission-scope label: read-only, edits after approval, or restore confirmation.
4. Arrow keys move the active choice; Enter accepts it; Escape closes the suggestion list. Clicking a result does the same.
5. Selecting a result only inserts the command. It never dispatches work by itself.
6. The submitted command prints a short preview before the agent workflow proceeds. File tools, installs, network access, and command execution remain governed by the existing runtime approval system.
7. /rollback always previews the affected files first and requires a separate /rollback confirm submission. The preview is invalidated if the latest checkpoint changes.

The terminal keeps its existing line editor, Tab completion, Ctrl+K command palette, and keybinding support. The browser keeps its current Ctrl+K palette; inline slash suggestions complement it instead of introducing another full-screen palette.

## Visual direction

- **Compact, precise, low-noise.** Use a single panel, thin border, restrained shadow, and tight spacing. Avoid large cards or marketing copy in the command path.
- **Code-friendly hierarchy.** Render command names in a monospaced face and descriptions in the existing UI font. Keep descriptions short and make permission scope visually secondary but readable.
- **Use existing theme tokens.** Respect OASIS foreground, panel, line, and accent variables so dark and light themes remain coherent.
- **Keep input focus.** The composer owns keyboard focus. Use combobox/listbox semantics and an active-descendant relationship; do not create a focus trap or require a mouse.
- **Mobile-safe geometry.** Clamp popup width to the viewport, position it above or below the composer based on available space, and cap height so it does not cover the whole conversation.
- **Accessible by default.** Preserve a visible active choice, text labels for all actions, keyboard operation, and meaningful expanded/active state. Do not use color alone to indicate permission scope.
- **Honest state.** Label an operation as read-only only when its runtime path enforces read-only tools. Show an explicit confirmation state for restoration. Never present an unverified capability or test as fact.

## Developer mental model

The six workflows are deliberately named around intent rather than internal tool names:

- /init: establish project context once, using real files and scripts as evidence.
- /plan: reduce risk before implementation; it is genuinely read-only.
- /fix: reproduce, isolate, change minimally, and verify.
- /diagnose: explain the evidence before recommending a change; do not silently fix it.
- /review: report confirmed findings with location and a failure scenario; read-only by default.
- /rollback: explain exactly what can be restored and preserve the current version first.

The skill defines the reusable process. Runtime code enforces capabilities, permissions, snapshots, and rollback. Avoid putting authorization rules only in natural-language skill text.

## Competitive references and what OASIS should learn

- **Claude Code** makes slash commands the discoverable entry point for both built-in commands and skills, and uses skills for repeatable procedures. OASIS follows that unified mental model while keeping the six primary engineering workflows explicit and portable.
- **VS Code** uses a central, searchable Command Palette and keyboard navigation to make a large set of actions discoverable. OASIS already has Ctrl+K, so the inline slash menu should stay focused on task workflows rather than duplicating all actions or replacing the palette.
- **WAI-ARIA Authoring Practices** defines combobox/listbox patterns and keyboard expectations for autocomplete. The browser menu should follow those semantics so it remains usable with a keyboard and assistive technology.

These are behavior references, not instructions to clone another product's visual identity. OASIS's differentiator here is the combination of a small workflow set, a cross-provider skill format, and a strict separation between instructions and runtime permissions.

## What not to add

Do not add vague multi-action commands, arbitrary command scripting, another plugin registry, a new agent loop, a command-specific modal for every action, or decorative animation that obscures state. Add a command only after it has a clear input contract, a bounded workflow, enforceable permissions, success criteria, and regression tests.

## References

- [Claude Code cheatsheet: slash command discovery, plan mode, permissions, skills](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet)
- [VS Code user interface and Command Palette](https://code.visualstudio.com/docs/editing/getting-started/userinterface)
- [WAI-ARIA Authoring Practices: combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
- [Anthropic: choosing between project instructions, skills, hooks, and subagents](https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more)

---

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


## Durable cross-session messages

- `/notify SESSION-ID-OR-NAME MESSAGE` stores a bounded structured message for a live session. Targets must be registered and alive; busy targets queue messages until idle. The store enforces a per-session rate limit and disallows forwarded-message loops.
- `/inbox` or `/inbox list` lists retained messages. Use `/inbox read MESSAGE-ID` to mark one read and `/inbox dismiss MESSAGE-ID` to dismiss it.
- Messages are untrusted contextual data. They do not become prompts, tool calls, permissions, or executable commands in the target session.


## Local investigation artifacts

- `/artifact NAME [GOAL]` creates or resumes a local investigation page and enables capture for the current session.
- `/artifact add NAME TYPE DETAILS` records a `timeline`, `command`, `file`, `test`, `error`, `hypothesis`, or `rollback` entry. `/artifact goal NAME TEXT` sets the task goal.
- `/artifact list`, `/artifact open NAME`, `/artifact stop NAME`, and `/artifact delete NAME` manage artifact lifecycle.
- Pages refresh locally every five seconds. Data is stored under the Oasis user config directory, not in the repository. No remote assets/scripts are loaded; common tokens/passwords/private keys are redacted before storage.


## Native Oasis plugin packages

A native plugin is a local directory with root `plugin.json` using `schemaVersion: 1`. It can bundle namespaced commands, skills, subagents, hooks, MCP server config and source files, plus metadata and a version. Example component paths are `commands/review.md`, `skills/review/SKILL.md`, `agents/reviewer.md`, `hooks/hooks.json`, `.mcp.json`, and `mcp/server.mjs`; list bundled server/hook source paths in `mcpFiles` and `hookFiles`.

Use `/plugin-package validate PATH` before install, then `/plugin-package install PATH --grant commands,skills` with only capabilities explicitly approved. Unapproved component files are not copied into the active install. Commands are namespaced as `/plugin-name:command` through Oasis's existing loader. Updates require a higher version; permission/request changes display a diff and no files change until you repeat with `--accept-permission-diff`. This initial native format installs local paths only; `/plugin` remains the marketplace adapter.
