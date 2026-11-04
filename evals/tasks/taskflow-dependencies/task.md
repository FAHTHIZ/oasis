Add task dependencies to the taskflow project.

- A task can be blocked by other tasks. Store this on the task as `blockedBy`: task IDs in ascending order, no duplicates. New tasks start with `blockedBy: []`. Task files written before this change have no `blockedBy`; they must still load and behave as if it were `[]`. The file `version` stays 1.
- `store.block(id, blockerIds)` adds blockers, saves, and returns the updated task. `store.unblock(id, blockerIds)` removes blockers (IDs that are not present are ignored), saves, and returns the updated task.
- `block` refuses, without changing or saving anything: a blocker equal to the task (`A task cannot block itself`), an unknown task or blocker (the existing `No task with ID <n>` error), and a blocker that would create a loop. The loop error is `Dependency cycle: ` followed by the loop as IDs joined with ` -> `, starting and ending at the task being blocked. For example, if 3 is blocked by 2 and 2 is blocked by 1, then blocking 1 on 3 fails with `Dependency cycle: 1 -> 3 -> 2 -> 1`.
- A task is blocked while at least one of its blockers is still open. Done blockers no longer count. Marking a blocked task done, whether through `store.update` or `taskflow done`, fails with `Task <id> is blocked by <open blocker IDs ascending, joined with ", ">` and changes nothing.
- Removing a task also removes its ID from every other task's `blockedBy`.
- CLI: `taskflow block <id> <blocker>...` prints `Task <id> is blocked by <all of its blockers, joined with ", ">.`. `taskflow unblock <id> <blocker>...` prints the same line, or `Task <id> is no longer blocked.` when none remain. Both need at least one blocker ID. The usage line lists the two new commands.
- `taskflow list --status blocked` shows open tasks that are blocked. `--status ready` shows open tasks that are not blocked. `open`, `done` and `all` keep their meaning.
- In list output, the line for a task that is still blocked ends with ` (blocked by #2, #5)`, listing its open blockers ascending, after any due text.

Keep every existing test passing and add tests for the new behavior.
