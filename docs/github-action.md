# Oasis on GitHub

Mention `@oasis` in an issue, a pull request, or a review comment, and Oasis runs in GitHub Actions. It reads the thread, makes the change, runs your tests, and replies with a summary.

- **On an issue:** it pushes an `oasis/issue-N-*` branch and opens a pull request that says `Closes #N`.
- **On a pull request from this repository:** it commits to the PR branch.
- **On a pull request from a fork:** it opens a new pull request instead.
- **Questions and reviews:** it answers in the thread without changing any files.

## Setup

1. Add your model provider's key as a repository secret, for example `OASIS_API_KEY`.
2. Copy [examples/oasis-github.yml](examples/oasis-github.yml) to `.github/workflows/oasis.yml`, then set `protocol` and `model`.
3. Comment `@oasis fix the flaky login test` on an issue.

Any provider Oasis supports works: OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint (set `protocol: openai-compatible` and `base_url`). On a self-hosted runner, that includes local models.

## Safety

- **Who can trigger it:** only authors with an `OWNER`, `MEMBER`, or `COLLABORATOR` association (change this with `allowed_associations`). Bots are ignored, so Oasis never replies to itself.
- **Permissions:** the default mode is `auto`. A classifier model approves routine steps such as tests and builds, and blocks risky ones such as uploads, force pushes, reading secrets, or `curl | sh`. The classifier only sees the request and the pending action, never the issue text or tool output, so instructions planted there can't approve anything.
- **Treating text as data:** issue and PR descriptions are passed to the agent as information, not as instructions.
- **Verification in unattended runs:** the Action does not launch project-configured language-server executables. It uses the repository's own test, lint, build, or type-check commands instead. If no relevant check passes after a source edit, OASIS reports verification as incomplete; it does not claim a language-server result.
- **Extra limits:** use `allowed_tools` to pre-approve exact commands and `disallowed_tools` to forbid others.
- **Pushing:** Oasis never runs `git push` itself. The action commits and pushes only the working-tree changes, and it never force-pushes.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `api_key`, `protocol`, `base_url`, `model` | | Model provider |
| `prompt` | | Run a task directly (for `workflow_dispatch` or `schedule`) |
| `trigger_phrase` | `@oasis` | Mention that triggers a run |
| `assignee_trigger`, `label_trigger` | | Also run when an issue is assigned to this user or gets this label |
| `allowed_associations` | `OWNER,MEMBER,COLLABORATOR` | Who can trigger runs |
| `permission_mode` | `auto` | `auto`, `default` (deny anything that would need approval), `acceptEdits`, `plan`, or `bypassPermissions` |
| `allowed_tools`, `disallowed_tools` | | Permission rules, for example `Bash(npm test:*)` |
| `max_turns` | `40` | Step limit |
| `effort`, `append_system_prompt` | | Tuning |

The action's outputs are `result` (the summary), `branch`, and `pull_request`.

## Scheduled tasks

~~~yaml
on:
  schedule: [{ cron: '0 6 * * 1' }]
jobs:
  deps:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: FAHTHIZ/oasis@main
        with:
          api_key: ${{ secrets.OASIS_API_KEY }}
          model: ${{ vars.OASIS_MODEL }}
          prompt: Update outdated dev dependencies, run the tests, and keep only the updates that pass.
~~~
