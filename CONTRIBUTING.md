# Contributing to OASIS

Thanks for helping improve OASIS. Bug fixes, focused feature work, documentation corrections and reproducible test cases are welcome.

## Before you start

- Read the [README](README.md) to understand the interfaces and their execution boundaries.
- Search [existing issues](https://github.com/FAHTHIZ/oasis/issues) and [discussions](https://github.com/FAHTHIZ/oasis/discussions) before opening a new topic.
- For substantial changes, open a discussion or issue first so the design and scope can be agreed before implementation.
- Never include API keys, access tokens, private project data or other credentials in an issue, test fixture or pull request.

## Development setup

Requirements: Node.js 22.19 or newer and Git.

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
```

## Before submitting a change

Run the checks relevant to your change:

```sh
npm test
npm run check
```

For changes to the agent harness, also consider `npm run bench:harness` and `npm run bench:tokens`. Keep benchmark fixtures deterministic and do not tune runtime behaviour against a held-out set without recording the methodology.

Include focused tests for behaviour changes. For permission, sandbox, filesystem or network changes, add regression cases for both the intended behaviour and nearby safe behaviour that must continue to work.

Review `git diff` before submitting. Explain the user-visible effect, relevant compatibility impact and exact checks you ran. Do not claim a test passed unless you ran it and observed a successful exit status.

## Pull requests

- Keep each change focused and use a descriptive title.
- Describe the problem and the chosen approach.
- List tests and checks, including any that could not be run.
- Call out changes to permissions, network exposure, data handling or provider behaviour.
- Update the README or relevant guide when user-facing setup or behaviour changes.

## Security reports

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) instead.
