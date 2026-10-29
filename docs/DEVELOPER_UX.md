# Developer UX for slash commands and portable skills

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
