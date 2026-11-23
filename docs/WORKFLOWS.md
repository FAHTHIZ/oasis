# Workflows

Representative ways to use OASIS beyond editing code. Every command on this
page exists in the current CLI (`oasis --help`). Each workflow names the tools
and checks involved so you know what the runtime enforces and what is left to
the model. How mature each piece is: [Capabilities and status](CAPABILITIES.md).

Run any of these interactively (`oasis`, then type the request), in the web app
(`oasis web --open`), or once from a script (`oasis -p "…"`).

## Research a question with cited sources

```sh
oasis -p "Compare the three most-used open-source vector databases: licence, hosting options, last release date. Cite every source."
```

The agent uses `web_search` and `fetch_url` (or the Chrome browser tool with
`--chrome` for pages that need JavaScript). The runtime keeps an evidence
ledger of every page actually fetched: a claim that cites a URL the agent never
opened is flagged before the answer reaches you.

For a larger question, the built-in deep-research workflow fans the work out to
parallel subagents and cross-checks their claims:

```text
/deep-research What changed in the EU AI Act obligations for general-purpose models in 2026?
```

It plans 3–6 search angles, runs one research agent per angle, votes on each
claim across agents and returns a cited report. Each claim comes with a
verbatim quote checked against the fetched page (`verify_quote`), verifiers
count [independent sources](AGENT-NETWORK.md#source-independence) so
syndicated copies count once, and the report calls a claim corroborated only
when two or more independent sources back it. The
[research pack](EXTENDING.md#domain-packs) adds a `researcher` and a
`fact-checker` agent with no write or shell tools:

```sh
oasis --plugin-dir plugins/oasis-research
```

## Debate a contested question

When the honest answer is "it depends" or experts disagree, `/debate` runs a structured debate instead of asking one agent for its opinion:

```text
/debate Does a four-day work week raise productivity? --rounds 2
```

1. **Frame**: 2–4 distinct, defensible positions (the strongest form of each) and the cruxes between them. Pass your own with `args: { question, positions: ["...", "..."], rounds }`.
2. **Opening**: one advocate per position, in parallel, with up to 5 arguments. Each argument is a claim with the URL of a page the advocate fetched and a verbatim quote from it, and each advocate also gives its confidence.
3. **Rebuttal** (1–3 rounds): every advocate sees the whole argument ledger and answers with typed moves. A `challenge` disputes an opponent's argument (with evidence where it is factual), `concede` accepts one, `counter` adds an argument that answers a specific one, and `withdraw` drops one of its own. Each round it restates its confidence and what evidence would change its mind.
4. **Fact-check**: every argument still disputed goes to an independent fact-checker that saw none of the debate. Its verdict is `supported`, `refuted` or `unsettled`.
5. **Judgement**: a judge with no tools rules on the record against a stated rubric: claims that survived, evidence quality, responsiveness, calibration. Next to its ruling the report shows a mechanical evidence tally (+3 supported or conceded, +1 unchallenged, +0.5 unsettled, −2 refuted, half for unsourced arguments) and flags any disagreement between the two.

The report gives the ruling with its confidence and each position's tally and confidence path, then the points of consensus, the remaining dissent, the cruxes (with the evidence that would settle each), what would change each side's mind, and the full argument ledger. Advocates and fact-checkers are held to the [report contracts](AGENT-NETWORK.md#evidence-and-contracts). An advocate whose report cites an unfetched page or misquotes one is sent back once; if it fails again, its position forfeits.

## Fact-check a text, file or page

`/factcheck` checks what a piece of writing claims, claim by claim:

```text
/factcheck https://example.com/article --max 10
/factcheck drafts/press-release.md
/factcheck The Eiffel Tower is 330 metres tall and opened in 1887.
```

1. **Extract**: the checkable claims (figures, dates, events, attributions, causal and comparative claims, descriptions of studies or laws) are rewritten to stand alone, so "it rose 12% last year" becomes "the city budget rose 12% in 2025". They are ranked by how much the text depends on them and capped at `--max` (default 10, at most 20). Opinions, predictions and advice are listed as not checkable.
2. **Check**: each claim goes to its own checker, which sees only that claim. The checker returns `true`, `mostly-true`, `misleading` (accurate but missing context that changes the conclusion), `false` or `unverifiable`, with quoted evidence and a correction for anything not true. The original source cannot vouch for itself: evidence from its site does not count. A verdict left with no independent evidence is reported as `unverifiable`.
3. **Challenge**: every confident verdict goes to an adversarial reviewer, whose only job is to overturn it with better evidence: a primary source, a newer figure, missing context. A strong, evidenced objection marks the claim `disputed` and shows both sides. A weak one caps its confidence at 60%.
4. **Verdicts**: a table of claims, verdicts, confidence and evidence links, the corrections, the disputes, notes per claim, and a weighted reliability score for what could be checked (true 1, mostly-true 0.8, misleading 0.3, false 0, weighted by how much the text depends on each claim).

Checkers and reviewers are held to the same [report contracts](AGENT-NETWORK.md#evidence-and-contracts) as research agents. They cite only pages they fetched, check their quotes with `verify_quote`, and count copies of one story as one source.

## Analyse data and produce a chart

```sh
oasis -p "Read sales.csv. Report revenue by region and month, flag the three largest month-over-month drops, and save a chart as report/revenue.png and the summary as report/summary.md."
```

The system prompt tells the model to compute numbers by running code rather
than in its head, and the analysis pack enforces it: with
`oasis --plugin-dir plugins/oasis-analysis`, every decimal, percentage or
larger number in the `analyst` agent's report must have been printed by code it
ran, or the report is sent back. Commands run under your permission mode (and
inside the sandbox if one is on).

## Write and revise documents

```sh
oasis "Draft a one-page project update from notes/*.md for a non-technical audience. Save it as update.md, then list anything in the notes you left out."
```

Deliverables are saved as files in the workspace, not only shown in chat, so
they can be reviewed in the web app's Files and Changes panels and undone with
`/rewind`. The web app also reads uploaded PDFs and images. Export a whole
session with `/export review.html` or `/export notes.md`.

## Automate recurring work

```sh
oasis schedule add "every 1d" "Summarise yesterday's new GitHub issues in this repo and save the summary to digests/"
oasis schedule daemon        # or keep `oasis web` / `oasis gateway` running; they run routines too
```

Routines accept cron expressions, RFC 5545 RRULEs, intervals, one-off times
and signed webhooks. Results can be delivered to a chat with a gateway's home
channel (`--deliver home`). An unattended run cannot answer approval prompts,
so it only does what your permission rules already allow.

## Work from a chat app

```sh
oasis gateway telegram       # or slack, discord, matrix, signal, email, whatsapp, mattermost, all
```

Allowlisted users talk to the agent in a workspace on your machine; approvals
arrive as buttons or typed replies; `/resume` continues a terminal session from
the chat. Setup per platform: [Gateways](GATEWAYS.md).

## Operate a browser or a desktop

```sh
oasis --chrome "Open the staging site, walk through sign-up, and report every console error with a screenshot."
oasis --computer-use "Open the spreadsheet on the desktop and copy the totals row into totals.txt."
```

`--chrome` gives the agent a Chrome tool over the DevTools protocol and saves
each browser session as an HTML recording under `.oasis/recordings/`.
`--computer-use` lets it take screenshots and use the mouse and keyboard after
one approval per session; `--computer-use=virtual` uses a private virtual
screen on Linux instead of yours. Computer use is unreleased and experimental:
see [Computer use](COMPUTER_USE.md).

## Split work across agents

```text
Use three explore agents in parallel: one maps the API routes, one lists the database tables, one lists the background jobs. Then write ARCHITECTURE-NOTES.md from their reports.
```

Subagents run in parallel or in the background, can work in their own git
worktree, and report back through a size-limited handoff. A scheduler caps how
many run at once, each can have a token, cost or step budget, and every
subagent's lifecycle and spend is written to a crash-safe ledger. Reports are
checked against what each subagent's own tools showed. See
[Subagents](SUBAGENTS.md) and [Agent network](AGENT-NETWORK.md).

To ask several models the same hard question and merge their answers, ask the
agent to use `mixture_of_agents` (unreleased). To run one task several times
and keep only a verified result:

```sh
oasis attempts 3 --verify "npm test" --apply "make the date parser accept ISO week dates"
```

## Software work

Software development remains a first-class workflow: read and edit files, run
tests and builds, review diffs (`/review`, `/security-review`), run a
read-only multi-reviewer `/audit`, commit and open pull requests, and drive a
dev server through the web app's Preview tab. The verification gate sends the
agent back when it reports success without having reviewed its diff or seen a
check pass. See the [Terminal guide](TERMINAL.md) and the
[User guide](USER-GUIDE.md).

## Connect another agent or tool

| To | Use |
| --- | --- |
| Let another agent framework call OASIS | `oasis a2a serve` ([A2A](A2A.md)) |
| Call a remote A2A agent from OASIS | the `remote_agent` tool with `a2aAgents` in settings |
| Use OASIS from Zed, JetBrains or another ACP editor | `oasis acp` ([Interfaces](INTERFACES.md)) |
| Expose OASIS's tools to an MCP client | `oasis mcp serve` |
| Embed OASIS in a Node.js program | `src/sdk.mjs` ([Interfaces](INTERFACES.md)) |
| Run in CI or on GitHub issues | `action.yml`, or `oasis cloud run "TASK"` |

## Recorded runs

Unscripted runs with real models, including what went wrong, are kept in
[Real-world runs](development/REAL-WORLD-RUNS.md).
