# Terminal guide

`oasis` with no arguments starts an interactive session in the current folder.
That folder is the workspace: file tools can only reach it (plus folders you add
with `--add-dir` or `/add-dir`), and commands start there.

```sh
oasis                              # chat in this folder
oasis "find out why the login test fails"   # start with a first message
oasis -c                           # continue the last session in this folder
oasis -r ID                        # resume a saved session (oasis sessions list)
oasis -w fix-login                 # work on a new git worktree and branch
```

## Typing a message

| You type | What happens |
| --- | --- |
| Plain text | A task or question for the agent |
| `@path/to/file` | Attaches that file (Tab completes paths) |
| `/name args` | A built-in or custom slash command (`/help` lists them) |
| `!command` | Runs the command in your shell yourself. Its output is added to your next message, so the agent sees what you saw |
| `# note` | Saves a note to project memory (`# user: note` for every project, `# local: note` for this machine only) |
| `exit`, `/exit` | Ends the session (it is saved; `oasis -c` brings it back) |

You can keep typing while the agent works. A message sent mid-task is delivered at
its next step, the same as a note in the web app.

## Keys

The defaults below can be changed with `/keys` (stored in `keybindings.json` in the
OASIS config folder).

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Send |
| <kbd>Shift</kbd>+<kbd>Enter</kbd>, <kbd>Ctrl</kbd>+<kbd>J</kbd> | New line |
| <kbd>Esc</kbd> | Stop the running step |
| <kbd>Esc</kbd> <kbd>Esc</kbd> | Rewind: undo the file changes of earlier turns (same as `/rewind`) |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | Cycle the permission mode (manual, accept edits, plan, auto) |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Interrupt; twice to quit |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Quit |
| <kbd>Ctrl</kbd>+<kbd>R</kbd> | Search earlier prompts |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> | Show or hide the to-do list |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Show or hide the full transcript |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> | Write the message in your `$EDITOR` |
| <kbd>Ctrl</kbd>+<kbd>V</kbd> | Paste an image from the clipboard |
| <kbd>Alt</kbd>+<kbd>P</kbd> | Model picker |

## Permission modes

| Mode | Behaviour |
| --- | --- |
| `manual` (default) | Read-only commands run; edits, other commands, installs, deletions and new websites ask first |
| `accept-edits` | File edits inside the workspace go through; commands still ask |
| `plan` | Read-only. The agent investigates and proposes a plan; nothing changes |
| `auto` | A classifier approves routine actions and asks about risky ones |
| `dont-ask` | Never waits: anything not already allowed is denied (for scripts) |
| `bypass-permissions` | Only with `--dangerously-skip-permissions`; high-risk commands still need a person |

Set the mode with `--permission-mode`, <kbd>Shift</kbd>+<kbd>Tab</kbd> or `/mode`.
Persistent rules are managed with `oasis permissions` and `/permissions`. Approval
prompts are an application control, not operating-system isolation; see
[Security](SECURITY.md).

## Commands you will use most

| Command | Purpose |
| --- | --- |
| `/help` | Every built-in and custom command |
| `/model`, `/effort` | Change the model or reasoning effort for this session |
| `/diff`, `/review` | See the changes so far; ask for a review of them |
| `/rewind`, `/undo` | Restore files to an earlier checkpoint |
| `/tasks`, `/agents` | Background tasks and subagents |
| `/goal CONDITION` | Keep working until a strict check says the condition holds |
| `/context`, `/compact` | How full the context is; summarise older turns |
| `/cost`, `/usage` | Estimated spend and token use |
| `/resume`, `/fork`, `/export` | Switch, branch or export sessions |
| `/mcp`, `/skills`, `/plugin` | Manage tools and extensions (see [Extending OASIS](EXTENDING.md)) |
| `/doctor` | Check the live session: model, tools, sandbox |

## Scripts and CI

`oasis -p "task"` (or `oasis exec "task"`) runs once without an interactive
prompt and exits. Useful flags:

| Flag | Effect |
| --- | --- |
| `--output-format text\|json\|stream-json` | Output shape; `stream-json` emits one event per line |
| `--permission-mode dont-ask` | Never wait for approval |
| `--goal "npm test passes"` | Keep going until the check holds; exit 1 if it never does |
| `--goal-verify` | With `--goal`: confirm a met goal with the `verify` agent, which runs the result |
| `--review [N]` | After work that changed files, the `verify` agent checks it against the request; failures go back to the agent for up to N fix rounds (default 1, max 3). A final failure exits 1 with `error_review_failed` |
| `--require-verified` | Exit 1 if OASIS could not verify its changes |
| `--receipt FILE` | Write a signed receipt of the run's evidence to FILE; check it with `oasis receipt verify FILE`. See [Receipts](RECEIPTS.md) |
| `--json-schema SCHEMA` | Return JSON matching a schema |
| `--max-turns N`, `--max-budget-usd N`, `--max-requests N` | Hard limits |
| `--zero-budget` | Only send requests to models proven free |
| `--allowedTools "run_command(npm:*)" "Edit(src/**)"` | Extra allow rules; several arguments, or one comma- or space-separated list |

The `json` result reports `usage` (tokens), `total_cost_usd`, the configured
`model`, and `modelUsage`: requests, tokens and cost for each model that
answered, including a fallback model, subagents and the advisor.

`oasis receipt verify FILE [--replay] [--trust KEY_ID] [--json]` checks a receipt
and exits 1 unless it holds; `/receipt [FILE]` writes one from an interactive session,
and `oasis receipt create --session ID` writes one for a saved session.

Piped input is added to the prompt: `cat build.log | oasis -p "explain this error"`.

## Sessions

Sessions are saved per workspace by default (`--no-session-persistence` turns this
off). `oasis sessions list|search|archive|prune` manages them from a shell. The web
app sees the same sessions under **Chats → Earlier on this computer**.

## Quieter output

`--calm` turns off animations and uses stable, finished lines, which suits slow
terminals and logs (`OASIS_NO_ANIMATION=1` turns off animations only).
`OASIS_AX_SCREEN_READER=1` adapts output for screen readers. `OASIS_NO_MASCOT=1`
hides the mascot. `NO_COLOR=1` turns off colour.
