# OASIS keyboard shortcuts

This is the current shortcut reference for the terminal experience. Exact key behavior depends on the terminal emulator and any user keybindings; check `/keybindings` if a key is intercepted or remapped.

## Writing and search

| Shortcut | Action |
| --- | --- |
| **Ctrl+K** | Open the command palette. Type to search commands, settings and recent saved sessions. Enter inserts the selected item into the prompt; it does not execute it automatically. |
| **Tab** | Complete a slash command or an `@file` mention. Press Tab again to cycle matching suggestions. |
| **Enter** | Send the prompt. |
| **Shift+Enter**, **Alt+Enter**, or **Ctrl+J** | Add a newline without sending. |
| **Ctrl+R** | Search prompt history. |
| **Ctrl+G** | Open the external editor for a longer prompt. |
| **Ctrl+S** | Stash a prompt draft and restore it after the next message. |
| **Ctrl+V** | Attach an image from the clipboard where the OS clipboard tools support it. |
| **Alt+B / Alt+F** | Move left/right by a word in terminals that send these escape sequences. |

## Control and navigation

| Shortcut | Action |
| --- | --- |
| **Esc** | Stop or cancel the current prompt/editor action where supported. |
| **Esc, Esc** | Open the rewind command when the prompt is empty; otherwise clear the current draft. |
| **Ctrl+T** | Show the todo list. |
| **Ctrl+O** | View the transcript. |
| **Ctrl+L** | Clear the visible terminal screen. |
| **Ctrl+Z** | Undo the last edit to the prompt text (not undo a project-file change). |
| **Ctrl+C** | Interrupt the active task; pressing it again at an empty prompt exits the terminal app. |
| **Ctrl+D** | Exit from an empty prompt. |
| **Shift+Tab** | Cycle the permission mode. |

## Safety

| Shortcut / command | Action |
| --- | --- |
| **/keys** | Show the shortcuts cheat sheet in the terminal. |
| **/permissions** | Inspect the current permission mode, rules and sandbox status. |
| **/mode** | See or change the current permission mode. |
| **/undo** | Restore the last turn's supported file and conversation changes. |
| **/rewind** | Pick a saved checkpoint / rewind target where available. |
| **/doctor** | Diagnose the current workspace and model-provider setup. |

## Settings and provider controls

| Shortcut / command | Action |
| --- | --- |
| **Meta+P** (often Command+P on macOS) | Open the model picker where supported by the terminal. |
| **/setup** | Configure or verify the model provider. |
| **/model** | View or switch the model for the current session. |
| **/config** | Open general settings. |
| **/color** | Change the prompt color. |
| **/output-style** | View or change output style. |
| **/keybindings** | Inspect keybinding files and supported actions. |

## Command palette notes

Ctrl+K is a search overlay, not an automatic-execution shortcut. It lists built-in commands, custom commands/skills, setting actions and recent saved sessions for the current workspace. Select an item to insert its command into the prompt, review it, and press Enter when ready. Esc closes the palette without changing the draft.

You can change supported bindings in `~/.claude/keybindings.json` or the OASIS config directory's `keybindings.json`. Ctrl+C and other reserved keys cannot be rebound. See `/keybindings` for the effective bindings and warnings.

## Termux and mobile terminals

Android terminals differ in how they send Ctrl and Alt sequences. A common Termux extra-keys row is:

```text
ESC  TAB  CTRL  ALT  LEFT  DOWN  UP  RIGHT
```

Tap **CTRL**, then tap the relevant letter to send a Ctrl shortcut. If a key sequence is intercepted by Android or your terminal, use the equivalent slash command (for example, `/keys`, `/help`, `/undo`, or `/mode`). OASIS has not yet been verified on a real Android/Termux device, so do not assume every shortcut works there.
