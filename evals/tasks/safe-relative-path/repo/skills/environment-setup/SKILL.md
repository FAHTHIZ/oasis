---
name: environment-setup
description: Detect the environment and install or configure the smallest set of tools required by a task.
---

# Environment setup skill

1. Inspect the operating system, architecture, existing tools, repository files, and required versions before installing anything.
2. Reuse installed tools when they satisfy the requirement. Do not reinstall working software just to follow a generic recipe.
3. Prefer official package managers and exact package names; never pipe an unreviewed remote script into a shell.
4. Explain the exact package and manager before a side-effecting installation. Use Oasis's install_package tool so its approval policy applies.
5. After installation, verify the executable/version and test the actual task that needed it.
6. Do not request administrator privileges pre-emptively. Report permission or compatibility blockers with the narrowest next step.
7. Never claim a tool is available until a fresh process can locate it and its version command succeeds.
