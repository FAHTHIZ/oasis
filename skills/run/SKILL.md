---
name: run
description: Launch and drive the project's app to see a change actually working, not only passing tests. Use after implementing a user-visible change.
---

# Run the app and see the change

1. Find how the project starts: a project skill or CLAUDE.md/AGENTS.md notes first, then
   `package.json` scripts, `Makefile`, `Procfile`, `docker-compose.yml`, `manage.py`, `cargo run`,
   README "Getting started". Prefer the documented dev command.
2. Install only what the lockfile already declares (`npm ci`, `pip install -r`, ...). Ask before
   installing anything new or touching global state.
3. Start long-running servers in the background (background shell / Monitor) and wait until the
   log shows it is ready (a port line or "ready" message) instead of sleeping blindly.
4. Drive the change the way a user would:
   - Web apps: open the page with the browser tool, click through the changed flow, read the
     console for errors, take a screenshot of the result.
   - APIs: call the changed endpoints with curl and show status codes and bodies.
   - CLIs: run the command with realistic arguments, including one failure case.
5. Compare what you saw with what the change should do. If it is wrong, fix it and drive it again.
6. Stop every process you started. Report the exact commands, what you observed, and anything you
   could not check (missing credentials, devices, external services).

If launching needs steps you had to discover, offer to save them as a project skill
(`.claude/skills/run-<project>/SKILL.md`) so the next run is one step.
