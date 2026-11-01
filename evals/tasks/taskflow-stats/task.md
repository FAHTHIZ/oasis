Add a `stats` command to the taskflow project. Add `summarize(tasks, now)` to `src/query.mjs`, returning `{ open, done, overdue, byPriority: { high, normal, low } }`, where `byPriority` counts open tasks only and `overdue` uses the existing overdue rule. `taskflow stats` prints exactly four lines:

```
Open: 3
Done: 1
Overdue: 1
By priority: high 1, normal 2, low 0
``` Keep every existing test passing and add tests for the new behavior.
