# Contributing to Oasis OSS

Thanks for helping improve Oasis. The goal is a useful, calm workspace with honest boundaries and minimal setup.

## Before opening a change

1. Briefly describe the problem your change solves.
2. Keep new features functional without a hosted service unless the feature explicitly adds one.
3. Prefer browser-native APIs and small, auditable additions over unnecessary dependencies.
4. Never place secrets, access tokens, user exports, or personal workspace data in commits.

## Local verification

Use Node.js 22 or newer, then run:

~~~bash
node scripts/check-site.mjs
~~~

For UI changes, open index.html in a desktop browser and on a narrow mobile viewport. Check keyboard access, empty states, and both themes where relevant.

## Pull requests

Explain the user-visible change, the checks you ran, and any known limitations. Update documentation whenever behavior or privacy boundaries change.

## Scope discipline

Do not describe a planned integration as shipped. New remote services require explicit architecture, privacy documentation, error handling, and a way to use the core workspace without them.
