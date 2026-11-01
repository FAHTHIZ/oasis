# taskflow

A small task tracker with a library API and a command-line interface. Tasks are stored as JSON in a single file.

```bash
taskflow add "Write release notes" --priority high --due tomorrow --tag docs
taskflow list --status open --sort due
taskflow done 3
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/task.mjs` | Task creation, validation and updates |
| `src/dates.mjs` | Due-date parsing (`2026-11-03`, `today`, `tomorrow`, `+3d`) and overdue checks |
| `src/query.mjs` | Filtering, sorting and pagination |
| `src/format.mjs` | Text rendering for the CLI |
| `src/store.mjs` | Loading and saving the JSON task file |
| `src/ids.mjs` | Task ID allocation |
| `src/events.mjs` | A minimal event emitter used by the store |
| `src/cli.mjs` | Argument parsing and commands |

Run the tests with `npm test`.
