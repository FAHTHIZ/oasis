---
name: web-app-development
description: Implement complete accessible web experiences with responsive UI, robust state, and tested runtime behavior.
---

# Web app development skill

1. Inspect the current routes, rendering approach, design tokens, build scripts, browser support, and existing tests before choosing a framework or adding dependencies.
2. Trace the user flow end-to-end: entry point, loading state, success state, empty state, validation, error recovery, keyboard use, and narrow-screen layout.
3. Reuse established visual patterns and shared components. Avoid introducing parallel implementations of the same feature.
4. Treat every browser input and imported file as untrusted. Escape rendered content, validate schemas and sizes, and avoid unsafe HTML injection.
5. Keep credentials and privileged operations on a trusted runtime. Browser code must not receive provider API keys, GitHub tokens, or server secrets.
6. Make loading and asynchronous work visible, prevent duplicate submissions, handle stale responses, and provide actionable error messages.
7. Add deterministic tests for logic and UI anchors; run the repository quality gate and inspect the final diff.
8. Verify responsive and accessibility behavior with real browser/device checks when available; clearly state what was not tested.