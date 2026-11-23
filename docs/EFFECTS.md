# Effect contracts

Source: `src/effect-contracts.mjs`, the command path in `src/agent.mjs`, `captureFromPreimage` in `src/checkpoints.mjs`.

Edits made through `write_file`, `edit_file`, `multi_edit` and `delete_file` are captured before they happen: `/rewind` can undo them and the evidence ledger knows which files they changed. A shell command used to be a blind spot. `sed -i`, `npm install`, a formatter, a code generator or a script could change any number of files, and the runtime only knew "this command may have written something". An effect contract closes that gap for every command that is not provably read-only.

## What happens around a command

1. **Prediction (the shadow).** Before the command runs, its command line is parsed (the same shell AST the permission checks use) and its effects are predicted: redirection targets, `tee`, `sed -i` / `perl -i`, `rm`, `mv`, `cp`, `touch`, `mkdir`, `chmod`, `git checkout -- path`, a formatter given files, a package manager's manifest, lockfile and install folder. A command whose effects cannot be bounded from its line (an interpreter running a script, a build tool, `git reset`, `tar`, an unparsable line) is predicted as `broad`.
2. **Snapshot before.** The working tree is written as a Git tree object through a private index (seeded from the real one so unchanged files are not hashed again). The user's index, `HEAD`, refs and stash are never touched; the blobs written are unreferenced objects that `git gc` collects, as with `git stash create`. `.gitignore` is respected.
3. **The command runs**, with permissions and approvals decided exactly as before. The contract grants nothing.
4. **Snapshot after, and diff.** The two trees are compared with `git diff-tree`. The result is exact to the file and independent of what the command printed or what the model says it did.
5. **Contract check.** Observed changes nobody predicted are `unexpected`. A broad prediction expects anything. A command that ran at the same time as another in the same tree is marked `concurrent` and nothing is held against it.
6. **Recovery.** The pre-command content of every changed file is put in the turn's checkpoint, so `/rewind` restores files changed by commands as well as by edit tools, and deletes files a command created. `restorePaths(root, snapshot, paths)` compensates a single command.

## What the model sees

The command result carries `effects`:

```json
{ "changed": 2, "files": ["app.js (modified)", "side-effect.txt (added)"],
  "unexpected": ["side-effect.txt (added)"], "held": false,
  "snapshot": { "before": "<tree>", "after": "<tree>" },
  "note": "Changed 2 workspace files: ... Not predicted from the command line: side-effect.txt (added). Check these were intended. /rewind can undo them." }
```

A command that changed nothing returns `{ "changed": 0, "held": true }`. Read-only commands (the same set that runs without a prompt) are not snapshotted at all.

## Evidence

The evidence ledger used to guess: any command that was not provably read-only was recorded as one that "may edit", which made every earlier passing check stale. With an observed effect, the guess is replaced: a command that changed nothing leaves earlier checks valid, and one that changed files makes them stale even when it looked harmless.

## Limits

- Only Git work trees are observed. Outside one, the session stops trying after the first attempt.
- Ignored files (build output, `node_modules`) are not tracked, so their changes are not reported or rewound.
- Files outside the workspace folder but inside the repository are reported with a `../` path and are not rewound.
- Effects outside the file system (network calls, databases, processes) are not observed.
- Background and interactive commands are not observed: their effects happen after the call returns.
- A snapshot that takes longer than 4 seconds twice turns observation off for the session. On the OASIS repository (about 2,000 tracked files) a snapshot takes about 150 ms.

## Turning it off

`OASIS_EFFECT_CONTRACTS=0`, or `"effectContracts": false` in settings.

## Compared with other runtimes

Claude Code's checkpoints do not track files changed by shell commands; Codex and Aider rely on Git commits made after the fact or on an OS sandbox that restricts writes but does not report them. Snapshot-based effect observation turns "the command might have written something" into an exact, reversible record per command, and the predicted-versus-observed comparison flags side effects that the command line did not announce, such as a script that also rewrites a config file.

The prediction is made from the command line alone, so programs (`python3 gen.py`, `make`, package scripts) are "broad". [Command rehearsal](REHEARSAL.md) measures their file changes before approval instead, and compares the real run against that rehearsal.
