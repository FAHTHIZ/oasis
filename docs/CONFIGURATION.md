# Configuration reference

This page documents configuration that is read by the runtime in `src/`. Each
section names the source file that implements it, so the text can be checked
against the code. Settings files are layered as described in
[Architecture](ARCHITECTURE.md#settings-and-workspace-trust).

## Permission modes

`--permission-mode` (or `/mode`, or `permissions.defaultMode` in settings) picks how OASIS handles calls that need approval:

| Mode | Behavior |
| --- | --- |
| `default` (`manual`) | Asks before commands, network access and protected-path edits. |
| `acceptEdits` (`accept-edits`) | Applies file edits without asking; still asks for commands. |
| `plan` | Read-only research; proposes a plan before changing anything. |
| `auto` | A classifier approves routine actions and blocks risky ones; asks when unsure. |
| `dontAsk` (`dont-ask`) | Never prompts. Calls that an allow rule or the mode default permits run; anything that would ask is denied with a reason the model can read, and the turn continues. |
| `bypassPermissions` | Skips approval prompts. Refused under `--restricted` or `permissions.disableBypassPermissionsMode`. |

`dontAsk` suits CI and unattended runs: pair it with `permissions.allow` rules for the commands the task needs. To keep your usual mode but turn every prompt into a denial, set:

```json
{ "permissions": { "denyInsteadOfPrompting": true } }
```

This setting only tightens, so OASIS honors it from any scope, including untrusted project settings. `PermissionDenied` hooks run for each denied call.

In `auto` mode the project's own checks (`npm test`, `npm run lint|build`,
`node --test`, `node x.test.js`, `pytest`, `cargo test`, `go test`,
`make test`) are approved without a classifier call, because they are what the
default "Test and build" allow rule describes. This applies only to plain argv
commands inside the workspace, and only while that default rule is in force. It
does not apply when the user's message says not to run them, or when the
`package.json` script that `npm test` (or `pnpm`, `yarn`, `bun run`) would run,
with its `pre` and `post` scripts, or the Makefile recipe behind `make test`,
reaches the network, pipes into a shell or deletes recursively. A test file
named on the command line (`node x.test.js`, `node --test file`, `pytest file`)
is read the same way: one that reaches the network, starts other programs or
reads the environment or credentials goes to the classifier with its code. The classifier then reads those scripts, since the agent
can edit them, and an earlier approval does not carry over to an edited
script. Everything else
goes to the classifier. It has 30 seconds to answer, stretched to 1.5 times the
main model's typical reply time (up to 180 seconds) when it runs on the same
model. Set `autoMode.timeoutSeconds` in user settings to choose the limit, or
set `autoMode.model` to a faster model. Source: `src/auto-mode.mjs`.

MCP tools also skip the classifier in `auto` mode when the server comes from
your user MCP config (never a project `.mcp.json`) and the tool declares
`readOnlyHint: true`, `openWorldHint: false` and no `destructiveHint`. Tools
whose names suggest secrets (`env`, `token`, `key`, `password`, `auth`...),
tools with a withheld description and tools whose definition changed still go
to the classifier. Source: `src/mcp.mjs` (`mcpToolDefinitions`).

A shell line made of several commands (`git add x && git commit -m y`) is
allowed when every piece matches some allow rule, as in Claude Code. A piece
nothing covers, a `$(...)` substitution or a dynamic word keeps it unapproved.
A command file's `allowed-tools` apply to the turn it starts, including
`oasis -p "/name"`. Its inline `` !`cmd` `` lines run when they match those
rules or are read-only inspection (`git status`, `git diff`, `git log`, `cat`
inside the workspace). Source: `src/permissions.mjs`, `src/commands.mjs`.

## Model providers

Source: `src/provider-registry.mjs`.

The runtime knows providers by name from one registry. Setup, the in-chat
`configure_provider` tool, `--fallback-model provider:model`, `oasis connect
--from-env`, local-server discovery (`oasis setup --auto`, `oasis doctor`) and
setup-preset inference all read it. The connected browser workspace in `app/core/` keeps its own
catalogue because it runs without Node.js.

Built-in providers:

| id | Protocol | Base URL | Key variables |
|---|---|---|---|
| `openai` | openai-responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `gemini` | openai-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `groq` | openai-compatible | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `deepseek` | openai-compatible | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `mistral` | openai-compatible | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `xai` | openai-compatible | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `moonshot` | openai-compatible | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| `huggingface` | openai-compatible | `https://router.huggingface.co/v1` | `HF_TOKEN`, `HUGGINGFACE_API_KEY` |
| `together` | openai-compatible | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `fireworks` | openai-compatible | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| `cerebras` | openai-compatible | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `nvidia` | openai-compatible | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `ollama` (local) | openai-compatible | `http://127.0.0.1:11434/v1` | `OLLAMA_API_KEY` (optional) |
| `lmstudio` (local) | openai-compatible | `http://127.0.0.1:1234/v1` | none |
| `llamacpp` (local) | openai-compatible | `http://127.0.0.1:8080/v1` | none |
| `jan` (local) | openai-compatible | `http://127.0.0.1:1337/v1` | none |
| `vllm` (local) | openai-compatible | `http://127.0.0.1:8000/v1` | `VLLM_API_KEY` (optional) |
| `omniroute` (gateway) | openai-compatible | `http://127.0.0.1:20128/v1` | `OMNIROUTE_API_KEY` |
| `freellmapi` (gateway) | openai-compatible | `http://127.0.0.1:3001/v1` | `FREELLMAPI_API_KEY` |

Amazon Bedrock, Google Vertex AI and Microsoft Foundry are configured through
`src/cloud-providers.mjs`, not this table.

`OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` (the OpenAI SDK and Claude Code
convention) are read only when `OASIS_BASE_URL`, `OASIS_PROTOCOL` and a saved
setup are all absent, so a variable exported for another tool never overrides
`oasis setup`. `ANTHROPIC_BASE_URL` selects the Anthropic protocol; any other
host on `OPENAI_BASE_URL` uses Chat Completions (`openai-compatible`).

Keys for local servers: OASIS never sends an ambient `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY` to a `localhost` address. A local gateway that needs a key
(LiteLLM, OmniRoute with authentication) gets `OASIS_LOCAL_API_KEY`, or
`OASIS_API_KEY` when `OASIS_BASE_URL` points at that server in the same
environment. A built-in provider on its default address also reads its own
variable (`FREELLMAPI_API_KEY` for `:3001`, `OMNIROUTE_API_KEY` for `:20128`,
`VLLM_API_KEY` for `:8000`), which is never sent to any other address:

```bash
OASIS_BASE_URL=http://127.0.0.1:4000/v1 OASIS_API_KEY=sk-litellm-key oasis
```

### OmniRoute gateway

[OmniRoute](https://github.com/cheaper-inference/omniroute) is an MIT-licensed,
self-hosted gateway: one OpenAI-compatible endpoint on `localhost:20128` that
routes to the providers you connect in its dashboard, with fallback, quota
tracking and `auto/*` routing combos.

1. Install and start it: `npm install -g omniroute`, then `omniroute` (Node.js 22.22.2+ or
   24–26; the setup wizard sets an admin password). The package is about 900 MB
   unpacked. By default it listens on `0.0.0.0` with no key required, so any
   device on your network can spend your provider quota; start it with
   `OMNIROUTE_SERVER_HOST=127.0.0.1 REQUIRE_API_KEY=true omniroute serve`.
2. In its dashboard, connect at least one provider and create an API key under
   **Endpoints**.
3. Connect OASIS. Paste the address, the key and (recommended) a model in one go:
   `oasis connect` → `http://localhost:20128/v1 sk-… llm7/codestral-latest`.
   Or use the environment: `OMNIROUTE_API_KEY=sk-… oasis connect --from-env`.

What OASIS does differently for a gateway:

- OmniRoute's model list includes models from providers that are not connected.
  When a probe fails with an account or upstream error, OASIS rules out that
  provider's other models in one step, never saves them as backups, and prefers
  backups from the upstream that answered.
- A 5xx such as "bridge is not configured" is not retried; the run moves to the
  next fallback at once.
- It runs on localhost but forwards to the cloud, so it is not offered as a local
  model, gets cloud timeouts, and is never priced as free. Model prices come from
  the [models.dev](https://models.dev) catalogue when the name is known. Use
  OmniRoute's own usage page for actual spend.

Tested on 2026-11-08 with OmniRoute 3.8.53 and the keyless LLM7 upstream
(`llm7/codestral-latest`, `llm7/gpt-oss:20b`): model discovery, streaming tool
calls, the paste flow and the no-retry path. LLM7's free daily token quota runs
out fast; OmniRoute passes its 429 through and OASIS reports it as a daily limit.

Re-tested on 2026-11-14 with OmniRoute 3.8.53 (Node 24.22.3, loopback, keys
required) and its `kilo-gateway` provider on Kilo's anonymous free routes:
`oasis -p` fixed a one-line bug through `kg/nvidia/nemotron-3-ultra-550b-a55b:free`
in 4 requests (9.4 s, 26,460 input tokens), with the key read from
`OMNIROUTE_API_KEY` alone. The catalogue lists that `:free` model at $0, so the
reported cost is $0; `--zero-budget` still refuses it, because a $0 listing is
not proof the route cannot bill.

### FreeLLMAPI gateway

[FreeLLMAPI](https://github.com/Azhan787/FreeLLMAPI) is a self-hosted,
OpenAI-compatible gateway on `localhost:3001` that pools free-tier keys you add
for each provider (Groq, Gemini, Cerebras, OpenRouter, keyless Kilo routes and
more) behind one unified key, with per-key rate-limit tracking and failover.

1. Run its server (`npm install` and `npm run dev`, or its Docker image), sign in
   to the dashboard, add provider keys, and copy the unified `freellmapi-…` key.
2. Connect OASIS: paste the key into `oasis connect` (a `freellmapi-` key is
   recognised and tried at `localhost:3001`), or set the environment:
   `FREELLMAPI_API_KEY=freellmapi-… OASIS_BASE_URL=http://127.0.0.1:3001/v1 OASIS_MODEL=auto oasis`.
3. For the browser app, add its origin to FreeLLMAPI's `DASHBOARD_ORIGINS` so
   the gateway answers cross-origin requests.

`auto` lets FreeLLMAPI pick a healthy model per request; naming a model (for
example `nemotron-3-ultra-550b`) keeps every request on that model. When OASIS
connects, it skips models the gateway lists as unavailable (`available: false`,
for example `no_key` when no upstream key is set). It moves models whose free
tier is used up for now (`execution_status: "exhausted"`) behind ready ones. It
puts alias slots such as `claude-opus-4-5` ("Opus slot (auto-routed to a free
model)") last, because they are not the model their name suggests. OASIS reads
each model's context window from the gateway's `GET /v1/models`, treats the
gateway as cloud (cloud timeouts, never priced or admitted by `--zero-budget` as
free: free tiers are not proof a route cannot bill), and reports
`"cost_known": false` in `-p --output-format json` results because the routed
model's price is not known. Respect each provider's own free-tier terms; the
gateway's combined allowance is not guaranteed.

With one upstream key, FreeLLMAPI can bench that key on its own. Seen on 2026-11-14: after three empty completions in a row (HTTP 200 from the upstream, no text and no tool call) it set a 10-minute heuristic cooldown, and every client got HTTP 429 "All models exhausted ... Soonest reset ~10m" with `Retry-After` until it expired. Add a second key or model in FreeLLMAPI, or set `OASIS_WAIT_FOR_RATE_LIMIT_MINUTES` (see [Rate-limit waits](#rate-limit-waits)) so OASIS waits instead of stopping.

Tested on 2026-11-14 with FreeLLMAPI from source and its keyless Kilo platform:
`oasis -p` fixed a one-line bug through `nemotron-3-ultra-550b` in 4 requests
(13 s, 26,531 input tokens), with the key read from `FREELLMAPI_API_KEY` alone.
`auto` reported a 1,048,576-token window; when it routes to a model with a
smaller one, OASIS learns the real limit from the overflow error and compacts.

### Adding or re-pointing a provider

Add a `providers` object to your user settings (`settings.json` in the config
directory: `$OASIS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/oasis` or
`~/.config/oasis`, or `%APPDATA%\oasis` on Windows), a `--settings` file, or
managed policy:

```json
{
  "providers": {
    "acme": {
      "protocol": "openai-compatible",
      "baseURL": "https://llm.acme.internal/v1",
      "keyEnv": ["ACME_API_KEY"],
      "model": "acme-coder",
      "label": "Acme gateway"
    },
    "groq": { "baseURL": "https://groq-proxy.example/v1" }
  }
}
```

- `protocol` must be `openai-responses`, `openai-compatible` or `anthropic`.
- `catalog` (optional) names the [models.dev](https://models.dev) provider whose
  context limits, output limits and prices apply, for a gateway that serves
  another provider's models (for example `"catalog": "anthropic"`). Built-ins
  already carry theirs.
- `baseURL` must be `http:` or `https:`.
- An entry that overrides a built-in keeps the built-in's other fields.
- Ids are lowercase letters, digits, `-` and `_` (up to 40 characters).
- Invalid entries are ignored, so a typo cannot stop OASIS from starting.

A repository's own `.oasis/settings.json` cannot define providers, even in a
trusted workspace: a provider entry decides where an API key is sent.

The environment can re-point any provider without a settings file:
`OASIS_PROVIDER_<ID>_BASE_URL` and `OASIS_PROVIDER_<ID>_MODEL` (the id upper-cased,
other characters replaced by `_`). For fallbacks only,
`OASIS_FALLBACK_<ID>_BASE_URL` is also read.

### Fallback models

`--fallback-model` (and the `fallbackModel` setting) takes a comma-separated
list. `provider:model` uses that registry provider with its own key, so the main
key is never sent to another provider; a bare model runs on the current
provider. Hosted providers without a key in the environment are skipped; local
servers do not need one. Source: `src/fallback-chain.mjs`.

### Advisor and mixture of agents

`advisorModel` (or `--advisor MODEL`, `/advisor MODEL`) gives the agent an `advisor` tool that asks one stronger model for guidance mid-task.

`mixtureModels` (or `OASIS_MIXTURE_MODELS`, `/mixture MODEL1,MODEL2,...`) gives it a `mixture_of_agents` tool: on a hard question, two to six models answer at the same time and one model merges their answers, fixing errors and naming any disagreement ([Mixture-of-Agents, Wang et al. 2024](https://arxiv.org/abs/2406.04692)). Entries use the same `provider:model` form as fallback models, so one mixture can span providers, and an entry whose provider has no key is skipped. The merging model is `mixtureAggregator`, a model on your main provider (or `OASIS_MIXTURE_AGGREGATOR`, `/mixture MODELS aggregator MODEL`), otherwise the session's own model. Each proposer ends with a stated confidence. Where OASIS has a track record for that model from [calibrated confidence](SUBAGENTS.md#calibrated-confidence), the merging model also sees how often that model's claims at that confidence have held (`stated confidence 0.95, calibrated 0.42 from 20 settled claims`), and the result lists both under `confidence`.

```json
{ "mixtureModels": ["openrouter:deepseek/deepseek-r1", "gemini:gemini-3-pro", "groq:moonshotai/kimi-k2-instruct"], "mixtureAggregator": "claude-opus-4-6" }
```

The models see the recent conversation, so these two settings are read only from your own settings, `--settings` or policy, never from a repository. Each round costs one request per model plus one to merge; `/mixture` shows the running total. Subagents cannot start a mixture.

### Endpoints without native tool calling

Some endpoints accept a request but drop the `tools` field, or drop system
messages: some free playgrounds, older vLLM and llama.cpp builds, and models
served without a tool parser. On these, the model answers in plain text and
never calls a tool. Prompt mode moves tool calling into the conversation
itself, as OpenHands does with its function-call converter:

| Setting | Environment | Effect |
| --- | --- | --- |
| `"toolCalling": "prompt"` | `OASIS_TOOL_CALLING=prompt` | The `tools` field is not sent. The tool list goes into the system prompt and the model writes `<function=NAME><parameter=KEY>value</parameter></function>`. Earlier calls are replayed in that format, and results come back as `EXECUTION RESULT of [NAME]:` user turns. `native` forces it off. |
| `"systemMessages": "user"` | `OASIS_SYSTEM_MESSAGES=user` | The system prompt goes inside the first user turn as `<system_instructions>`, and later system notes become `<system_reminder>` user turns. |

Calls written as text go through the same validation, permissions, hooks and
approvals as native calls. Prompt mode applies to the Chat Completions
protocol (`openai-compatible`). It was checked with gpt-oss-20b on a real
endpoint: it fixed a failing test in 13 requests, and none of them sent `tools`.
The tool list makes the prompt longer, so endpoints with a small input limit
(for example, 6,000 characters) still cannot run a full agent turn. OASIS
reports that limit as "Prompt too long" instead of retrying a server error.
Source: `src/prompt-tools.mjs`.

## Task-aware model routing

Source: `src/model-routing.mjs`, integrated by `src/agent.mjs`.

Automatic routing is optional and uses two models on the active provider:

```text
/routing easy MODEL_ID
/routing strong MODEL_ID
/routing on
/routing cascade
/routing status
```

Clearly simple, read-only requests can use the easy model. Complex, ambiguous,
security-sensitive, repository-specific or tool-requiring requests stay on the
strong model. The strong model defaults to the session model unless a different
one is configured. Use `/routing off` to pause routing or `/routing reset` to
remove the saved routing configuration. The `/usage` report includes estimated
savings when model prices are known.

### Cascade: start cheap, escalate on evidence

Source: `src/escalation.mjs`.

```text
/routing easy CHEAP_MODEL
/routing strong STRONG_MODEL
/routing cascade
```

or in user settings:

```json
{ "modelRouting": { "enabled": true, "mode": "cascade", "easyModel": "CHEAP_MODEL", "strongModel": "STRONG_MODEL" } }
```

In cascade mode, coding tasks that would go to the strong model start on the
easy model instead. The strong model takes over the rest of the task, once,
the first time the run shows objective evidence of being stuck:

- the same check fails the same way after three rounds of edits;
- the same failing command is run again with no change in between, enough
  times that the turn would otherwise stop;
- the same tool call returns the same result three times, or a no-progress
  cycle repeats within eight steps.
- the same tool is refused four times for the same reason, even with
  different arguments (a second refusal first adds a reminder of the request).

A streamed reply that keeps repeating the same text (2,000+ characters of one
unit repeated at least ten times) is cut off and sent back once with a note;
three such replies in a row end the turn with an error.

Without cascade, these signals end the turn with "I'm stuck". With cascade,
the strong model gets a note saying what failed and continues from the same
conversation. The terminal prints `[routing] escalated at step N from A to B: reason`,
and the result's `modelRouting.escalation` records the step, signal, models and
reason. An OpenTelemetry event `oasis.model_escalation` is emitted when
telemetry is on. After the task, the session returns to its own model.

Limits, stated plainly:

- Security-sensitive tasks and tasks hinted as hard still start on the
  strong model. Easy read-only tasks use the easy model as before.
- Escalation reacts to being stuck, not to answer quality. A cheaper model that
  finishes confidently with a wrong change, and passes the verification gates,
  is not escalated. Whether cascade beats the strong model alone on cost per
  solved task depends on the models and tasks; measure it before relying on
  it: `oasis eval --route-easy-model A --route-strong-model B --route-mode cascade --trials 3 --yes`
  against a plain run on B. Each trial records whether and when it escalated.
- In zero-budget mode, escalation happens only when the strong model is
  proven free (local, an OpenRouter `:free` variant, or declared in
  `OASIS_FREE_MODELS`); otherwise the run stops as before and
  `modelRouting.escalationSkipped` says why. A strong model outside
  `availableModels` is never used.
- `/routing classify` returns to read-only-only routing.

### Capability routing from eval results

`oasis eval --route-table` turns saved eval reports, one per model, into a
routing table: for each task class in `evals/tasks/metadata.json`, the
cheapest model whose pass rate is at or above a floor (default 80%) and no
more than a set drop (default 2 points) below the baseline model. Nothing is
run; the table is a pure function of the reports and the options, and its
digest is printed so a decision can be reproduced.

```sh
oasis eval --trials 3 --yes > strong.json   # one report per model
oasis eval --route-table strong.json mid.json cheap.json --floor 0.8 --max-drop 0.02 --out table.json
```

It prints the settings to paste:

```json
{ "modelRouting": { "enabled": true, "mode": "capability", "strongModel": "STRONG_MODEL", "routes": { "input-validation": "CHEAP_MODEL", "overall": "MID_MODEL" } } }
```

A task goes to the route for its class, or to `overall` when its class is
unclear. Security-sensitive and hard-hinted tasks stay on the strong model, and
a routed run that gets stuck moves to the strong model as in cascade mode.

Work that is not code (data analysis, writing, research synthesis, planning,
operations) is classed by the task model's domain, the same reading planning
and verification use (see [Task model](TASK-MODEL.md)), and only when code
wording is absent or far behind. Code tasks are classed by keyword rules.

Limits, stated plainly: the class is a guess from the task text. On the 59
eval task prompts it names a class for 37 and gets 27 of those right; the rest
use `overall`. Every miss is between two code classes. The cost gate (cost drops with
no class falling more than 2 points on the harness) has not been measured, so
this mode is off unless you turn it on.

The model catalogue imports the upstream `tool_call` flag when it is present.
For a task that needs tools, OASIS avoids selecting a model explicitly marked as
not supporting tool calls and keeps the current model instead, unless the
current model is also explicitly marked unsupported. Missing metadata remains
unknown; it is not treated as proof that a model cannot call tools. Provider
metadata can be incomplete or stale, so this is a conservative routing guard,
not a live tool-capability probe.

Subagents can also pick their model from their own track record:
`"modelRouting": { "subagents": "experience" }` starts a subagent on the
cheapest configured model that has done as well as the default on the same
agent type and kind of work. See
[Choosing models from experience](SUBAGENTS.md#choosing-models-from-experience).

## Run report

Source: `src/run-report.mjs`. After each task, `/report` shows what happened:
the model chosen and why, whether it escalated (or why escalation was skipped),
provider fallbacks, the requests and tokens per model, side requests such as
compaction or subagents, tool calls, and the outcome (finished, finished but not
verified, stopped, cancelled or failed). `/report json` prints the raw record,
which is also returned as `result.runReport`.

The cost line is labelled by where it came from:

- provider-reported: every request carried the provider's own charge (for
  example OpenRouter's `usage.cost`);
- estimate: computed from the model price table, because at least one
  request had no provider charge;
- unknown: some model had no known price.

Token counts are labelled when any request was estimated from text length
because the provider returned no usage. The report covers only requests OASIS
makes itself. External CLIs, MCP servers and hooks run outside it, and their
usage and cost are not included.

## Output token limit

Source: `maxOutputTokensFor` in `src/agent.mjs`.

1. `OASIS_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` or the
   `maxOutputTokens` config value, clamped to 1,024–128,000.
2. Otherwise the model's output limit from the models.dev catalog
   (`src/model-catalog.mjs`), capped at 32,000 and at a quarter of the model's
   context window.
3. Otherwise a name-pattern default: 8,192 for older models, 16,384 for
   GPT-4o/GPT-4 Turbo, 32,000 for recent families.

If a provider rejects the request as too large, the turn retries with the limit
parsed from the error.

## Reasoning replay

Source: `replaysReasoning` in `src/agent.mjs`.

Models with interleaved thinking expect the `reasoning_content` from their
previous reply to be sent back with the next request, so their reasoning
carries across tool calls. On OpenAI-compatible endpoints OASIS sends it back
when:

1. the `replayReasoning` config value is `true` (`false` turns replay off;
   the value applies only to the model it was saved with);
2. otherwise, the models.dev catalog lists the model's `interleaved` field as
   `reasoning_content` (for example DeepSeek, Kimi, GLM, MiMo and many hosted
   Qwen and MiniMax builds);
3. otherwise, the base URL or model name contains `deepseek`, `moonshot` or
   `kimi`.

## Search tools

Sources: `src/tools.mjs`, `src/power-tools.mjs`, `src/git-visible-files.mjs`.

- `glob_files` and `search_files` list files with `git ls-files` (honouring
  `.gitignore`) or, outside Git, a directory walk bounded at 250,000 entries.
  Patterns are matched while listing, so result caps count matches, not files
  seen.
- `search_files` runs ripgrep (`-F -i`, files up to 256 KB) when a ripgrep binary
  is available (bundled `@vscode/ripgrep`, `OASIS_RIPGREP_PATH`, or `rg` on
  `PATH`), and a JavaScript scan otherwise.
- `grep` accepts `pattern`, `path`, `glob`, `type`, `output_mode`
  (`content`, `files_with_matches`, `count`), `ignore_case`, `context`, `before`,
  `after`, `multiline`, `limit` and `offset`. It also accepts ripgrep-style names
  that models trained on other harnesses send: `-i`, `-C`, `-A`, `-B`,
  `head_limit`.
- Content results show at most about 400 columns per line. When the first match
  on a line starts beyond that (minified bundles, generated JSON), `grep` shows
  a window of roughly 120 characters before and 240 after the match, marked
  `[match at column N of a long line]`. With ripgrep this uses a second,
  match-only pass (`-o -b --column`) over the affected files (up to 50).

## Command output

Sources: `src/output-condense.mjs`, `runWorkspaceCommand` in `src/tools.mjs`,
`runShell` in `src/power-tools.mjs`.

`run_command` and `run_shell` pass command output through a streaming filter
before the model sees it. It removes only:

- node --test / TAP: the `# Subtest: X` line directly before `ok N - X`, and the
  YAML block after a passing test when it holds only `duration_ms` and `type`.
  Failing tests (`not ok`) and blocks with any other key keep every line.
- npm's "New major version of npm available" banner. Other `npm notice` lines
  stay.
- go test -v: `=== RUN   X` directly followed by `--- PASS: X`.
- Progress redraws: a line rewritten with carriage returns keeps its final frame.

When lines were removed, the result has an `outputCondensed` note. `run_command`
also keeps the raw output in `.oasis/command-logs/` (the same place truncated
output goes) and names the file; `run_shell` keeps no raw log. That directory
contains a `.gitignore` with `*`, so logs do not appear in `git status`,
`git_diff` or `git add -A`. Set `OASIS_CONDENSE_OUTPUT=0` to turn the filter off.

`run_command` with `interactive: true` starts the command in a pseudo-terminal
and waits up to `OASIS_INTERACTIVE_SETTLE_MS` (default `5000`, at most `30000`,
`0` returns at once). A command that exits in that time returns its output and
exit code like an ordinary run; one still running (a REPL, a prompt) returns
its id, the output so far and `nextOffset` for `terminal_read`. A check still
running has no exit code yet and does not count as passed or failed.

## Context trimming

Sources: `supersedeHistory` in `src/superseded-results.mjs`,
`pruneOldToolOutput` and `microcompact` in `src/context.mjs`,
`leanToolContent` and `providerSkipsCache` in `src/agent.mjs`,
`refreshTodoPrompt` in `src/tool-results.mjs`.

Every request resends the whole conversation, so OASIS trims what the model
no longer needs before each request, in this order:

- Lossless: an older read of a file that was read again, or an earlier run of
  the same command, becomes a one-line stub. This runs on every request once a
  model has answered two requests without reporting any cached tokens.
  Otherwise it waits until the history reaches half the context window, so
  the provider's cached prompt prefix stays intact. Set
  `OASIS_SUPERSEDE_RESULTS=0` to turn it off.
- Budget pruning, as in OpenCode: the newest 40,000 tokens of tool output are
  kept as they are. Older outputs become re-run stubs, but only when that
  frees at least 20,000 tokens, so the cached prefix is rebuilt rarely and
  only for a large saving. Checklist, skill and tool-search results are never
  pruned. `OASIS_PRUNE_PROTECT_TOKENS=60000` (or `"pruneToolOutputTokens"` in
  the config) changes the budget, and `0` turns it off. This only affects long
  sessions: replayed recorded feature tasks of 12–32 requests never held 40K
  tokens of tool output.
- Microcompaction: at half the context window, old bulky tool output is
  stubbed until the history is back to about 35%.
- Edit, multi-edit and delete results reach the model without `beforeBytes`,
  `afterBytes` and `backupCreated`; the terminal still shows them.
- Each `todo_write` update reaches the model once, as the checklist reminder;
  the tool result says the checklist was saved.

The terminal's turn line separates cache reads: `Done · 9s · 126k tokens (98.4k
cached)`.

## Edit checks

Sources: `verifyEditedFileWithLsp` and `nodeSyntaxCheck` in `src/lsp.mjs`.

After `write_file`, `edit_file` and `multi_edit`, OASIS asks the language
server for that file type for new diagnostics. When no language server is
running for a `.js`, `.mjs` or `.cjs` file, it runs `node --check` instead,
which parses the file without running it. If the file does not parse, the
edit result carries `syntaxCheck` and a `warning` with the `SyntaxError`, so
the model can fix it before running anything. Set `OASIS_EDIT_SYNTAX_CHECK=0`
to turn this off.

## Terminal progress

While a turn runs, terminals that implement the OSC 9;4 progress sequence show a busy
indicator in the tab or taskbar. The indicator switches to paused while OASIS waits
for your approval and to error when a turn fails. Supported terminals: Windows
Terminal, ConEmu, Ghostty 1.2+ and iTerm2 3.6.6+. Other terminals, multiplexers, CI
and pipes get nothing, because older terminals show OSC 9 as a notification. Set
`OASIS_TERMINAL_PROGRESS=off` to disable it, or `on` to force it.

## Inline images

In terminals that support graphics (Kitty and Ghostty through the Kitty protocol;
iTerm2, WezTerm, Warp and the VS Code terminal through the iTerm2 protocol), images
returned by tools and images attached with `@path.png` are previewed inline, at most
16 rows tall. Previews are skipped inside tmux, screen and Zellij, in CI, and when
output is not a terminal. Set `OASIS_INLINE_IMAGES=0` to disable them, or
`OASIS_INLINE_IMAGES=kitty` / `iterm` to force a protocol.

## MCP tool filters

A server entry can hide tools from the model. `allowedTools` keeps only the
listed tools and `disabledTools` removes tools; `disabledTools` wins when both
match. Each entry is an exact tool name or a prefix ending in `*`. Codex
spellings (`enabled_tools`, `disabled_tools`) are read too. This works in a
project `.mcp.json`, plugin servers and the user `mcp-servers.json`:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "allowedTools": ["get_*", "list_*", "search_*"],
      "disabledTools": ["get_secret_scanning_alert"]
    }
  }
}
```

A malformed list (spaces, `*` in the middle) stops that server from starting
and is reported, instead of silently exposing every tool. Source:
`src/mcp-trust.mjs` (`filterServerTools`).

## Lazy MCP servers

By default every MCP server starts with the session. Add `"lazy": true` to a
server entry (in `.mcp.json`, plugin servers or `mcp-servers.json`) to start
it only when one of its tools is first called. This saves a process per idle
server, which matters on low-memory machines:

```json
{ "mcpServers": { "docs": { "command": "docs-mcp", "lazy": true } } }
```

How it works and what it does not do:

- The first time, the server starts normally so OASIS can save its tool list
  to `mcp-manifests.json` in the config directory. Later sessions advertise
  those tools without starting the process. Changing the server's command,
  arguments, URL or working directory makes the saved list stale, and the
  server starts eagerly once more.
- When the server starts, a call is checked against the live tool. If the
  tool is gone or its definition differs from the saved one, the call is
  refused and the tool list is refreshed, so description inspection and
  pinning apply to the real tool.
- Per-call approval works as before. Starting the process does not itself
  need approval, as with eager servers.
- Resources, prompts and server instructions are unavailable until the
  server has started.
- `/mcp` marks a server that has not started yet.

Source: `src/mcp-lazy.mjs`.

## Stream retries

A reply stream that drops mid-response is sent again, up to `OASIS_STREAM_MAX_RETRIES` times (default 5, as Codex's `stream_max_retries`; 0 to 20), with a growing pause between tries (0.25 s up to 10 s). A stream that goes silent fails after `OASIS_STREAM_IDLE_SECONDS` (default 300, or 600 at high, xhigh or max reasoning effort). Because each stall already took a full idle window, a stalled stream is restarted at most twice. A provider error of 500 or above reported mid-stream gets one extra try. A dropped stream never returns tool calls, so a restart cannot run a tool twice.

## Rate-limit waits

A per-minute limit with a short stated wait (90 s or less, from the body or a hint such as FreeLLMAPI's "Soonest reset ~28s") is waited out automatically: up to 6 times with no backup model, once when a fallback chain is set. A longer reset is not waited for by default, so an interactive run is not left silent for minutes. For unattended runs set `OASIS_WAIT_FOR_RATE_LIMIT_MINUTES=N`: a request that is still rate-limited after the normal retries sleeps until the reset the provider advertises (`Retry-After`, Anthropic's or OpenAI's reset headers) when it is at most N minutes away (maximum 1440), and tries again, up to 3 times. Billing and out-of-credit errors never wait. When OASIS stops on a 429 whose reset it could have waited for, the error names the setting and a value that covers it.

Source: `src/provider-retry.mjs` (`shortRateLimitMs`, `rateLimitWaitMs`, `rateLimitWaitHint`).

## Model circuit breaker

When a fallback chain is set, each model gets a circuit breaker. After `OASIS_BREAKER_THRESHOLD` (default 2) consecutive provider failures (5xx, rate limit, out of credit, rejected fallback key) the chain skips that model. After `OASIS_BREAKER_COOLDOWN_SECONDS` (default 30) one probe request is allowed; each failed probe doubles the wait, up to 30 minutes. A success closes the breaker.

## Long-running MCP tools

When an MCP server supports tasks (MCP 2025-11-25) and a tool declares
`execution.taskSupport`, OASIS runs the call as a task: it polls the server and
sends `tasks/cancel` if you interrupt. A task still running after 5 seconds moves
to the background in the interactive terminal and in streaming headless sessions.
The turn continues, and the result arrives later as a notification that wakes an
idle session.

| Variable | Effect |
| --- | --- |
| `MCP_TOOL_TIMEOUT` / `OASIS_MCP_TOOL_TIMEOUT_MS` | How long one MCP tool call may run, in milliseconds (default `120000`, up to a day). |
| `OASIS_MCP_TASK_BACKGROUND_MS` | Grace period before a task moves to the background (default `5000`). |
| `OASIS_MCP_TASK_BACKGROUND=0` | Always wait for the task. `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1` does the same. |

One-shot `oasis -p` runs and the browser workspace always wait for the result.

## Connected apps

`/connect NAME` (terminal or web), Settings → Apps and the agent's
`connect_service` tool all add an app from the built-in catalog or any remote
MCP server URL; see [Connect apps](USER-GUIDE.md#connect-apps). OASIS reads
`package.json`, `requirements.txt`, `pyproject.toml`, well-known config files
(`vercel.json`, `netlify.toml`, `wrangler.toml`, `prisma/schema.prisma`, ...)
and git remotes to suggest the apps a project uses. Nothing is executed.

| Variable | Effect |
| --- | --- |
| `OASIS_NO_APP_HINTS=1` | Leave the "apps this project uses that are not connected" line out of the system prompt. |
| `OASIS_TIP=off` | No start-up tip in the terminal, including the project-apps tip. |

## Personalities

A personality sets the agent's voice and tone without changing what it does, what it may do, or how careful it is: code, commands and quoted output stay exact. It is separate from output styles (`/output-style`), which shape how replies are structured, so the two combine.

`/personality` lists them and `/personality NAME` switches the current session, in the terminal, the web app and every chat gateway (each chat keeps its own). `/personality none` turns it off. Built-ins: `helpful`, `concise`, `technical`, `teacher`, `creative`, `mentor`, `philosopher`, `hype`, `noir`, `pirate`, `shakespeare`, `surfer` and `kawaii`.

Pick a default with `"personality": "teacher"` in settings or `OASIS_PERSONALITY=teacher`. Add your own as a Markdown file in `.oasis/personalities/NAME.md` (this project) or `personalities/NAME.md` in the OASIS config folder (everywhere), with an optional `description:` in front matter, or inline in settings:

```json
{ "personalities": { "butler": "Speak like a formal English butler.", "coach": { "description": "Sports coach", "prompt": "Talk like an upbeat sports coach." } } }
```

A personality with the same name as a built-in replaces it. A project's `.oasis/personalities` files and inline definitions count only in folders you trust; an untrusted project may still pick one by name.

## Home Assistant

Set `OASIS_HASS_URL` (for example `http://homeassistant.local:8123`) and `OASIS_HASS_TOKEN` to a long-lived access token (your Home Assistant profile → Security → Long-lived access tokens) and the agent gets two tools through the [REST API](https://developers.home-assistant.io/docs/api/rest/). `HASS_URL` and `HASS_TOKEN` work too.

| Tool | What it does |
| --- | --- |
| `home_assistant` | Read-only: lists entities with their state (filter by domain or a search word), reads one entity's attributes, lists a domain's services and fields. Allowed in plan mode. |
| `home_assistant_control` | Calls a service such as `light.turn_on` or `climate.set_temperature`. Asks for approval each time; auto mode and allow rules skip the question, except for locks, alarms, covers (garage doors), valves, sirens, cameras and climate devices, which always ask. |

OASIS refuses services that run code or manage the host (`shell_command`, `command_line`, `python_script`, `pyscript`, `rest_command`, `hassio`, `recorder`, `homeassistant.restart` and `homeassistant.stop`). The token can do anything your Home Assistant user can, so give OASIS a dedicated non-admin user. With a gateway running you can then say "turn off the porch light" from Telegram or WhatsApp, or have a routine check the sensors every evening.

## Honcho user modeling

[Honcho](https://honcho.dev) (by Plastic Labs, Apache-2.0) keeps a long-term model of you across sessions, projects and chat platforms. When it is configured, OASIS sends every finished turn (your prompt and the final reply) to a Honcho session; Honcho reasons over them in the background and builds a peer card (key facts), conclusions and a representation of you. OASIS talks to the [v3 REST API](https://docs.honcho.dev/v3/api-reference/introduction) directly, so nothing extra is installed.

Set `HONCHO_API_KEY` for Honcho cloud (`api.honcho.dev`, keys at [app.honcho.dev](https://app.honcho.dev)), or `HONCHO_URL` (also `OASIS_HONCHO_URL`) for a self-hosted server. `oasis honcho test` (or `/honcho test`) checks the connection; `oasis honcho` shows the workspace, peers, thread and sync state. `OASIS_HONCHO=0` turns it off for one run.

| Tool | What it does |
| --- | --- |
| `honcho_profile` | Reads or replaces your peer card. |
| `honcho_search` | Semantic search over what you said in earlier sessions; returns your own words. Read-only. |
| `honcho_context` | The current thread's summary, your representation and card, and recent messages. Read-only. |
| `honcho_reasoning` | Asks Honcho a question about you ("what testing style do I prefer?"), with `reasoning_level` minimal to max. Read-only. |
| `honcho_conclude` | Records, lists or deletes conclusions about you. |

Settings (user or trusted project settings only, because `baseUrl` decides where conversations go):

```json
{ "honcho": { "workspace": "oasis", "peerName": "fahim", "aiPeer": "oasis", "recallMode": "hybrid", "sessionStrategy": "per-directory", "contextTokens": 1200, "sync": true } }
```

- `recallMode`: `hybrid` (default) adds what Honcho knows about you to the system prompt and offers the tools; `context` only adds the prompt block; `tools` only offers the tools.
- `sessionStrategy`: which Honcho thread a session writes to: `per-directory` (default), `per-repo` (the enclosing git repository), `per-session`, or `global`. Chat gateways always use one thread per chat (`telegram-123`, `discord-456`) under the same user peer, so what OASIS learns on Telegram carries over to the terminal.
- `contextTokens` caps the system-prompt block (100–20000, default 1200). `sync: false` (or `OASIS_HONCHO_SYNC=0`) stops sending turns while keeping the tools.
- Environment overrides: `OASIS_HONCHO_WORKSPACE` (or `HONCHO_WORKSPACE_ID`), `OASIS_HONCHO_PEER`, `OASIS_HONCHO_AI_PEER`, `OASIS_HONCHO_RECALL`, `OASIS_HONCHO_SESSION`, `OASIS_HONCHO_CONTEXT_TOKENS`.

Credentials the secret shield recognises and `<private>...</private>` spans are redacted before anything is sent. Subagents do not sync, and only the main agent can change your card or conclusions. Honcho being slow or down never blocks a turn: sync waits at most four seconds and errors show in `oasis honcho`.

## Remote A2A agents

`a2aAgents` in user settings names remote [A2A](A2A.md) agents the model can call with the `remote_agent` tool. Values are a URL or `{ "url", "token", "tokenEnv", "description" }`; up to 32 agents. Project settings cannot add them. `oasis a2a serve` makes OASIS itself an A2A agent. See [A2A](A2A.md).

```json
{ "a2aAgents": { "reviewer": { "url": "http://127.0.0.1:9000", "tokenEnv": "REVIEWER_TOKEN" } } }
```

## Telemetry (OpenTelemetry)

Telemetry is off unless `OASIS_ENABLE_TELEMETRY=1`. OASIS then sends metrics, log events and traces over OTLP/HTTP JSON to `OTEL_EXPORTER_OTLP_ENDPOINT` (per-signal `OTEL_EXPORTER_OTLP_{METRICS,LOGS,TRACES}_ENDPOINT` and `_HEADERS` work too). `OTEL_{METRICS,LOGS,TRACES}_EXPORTER` takes `otlp`, `console` or `none`.

Retries and recoveries are recorded too. Each one sends an `oasis.recovery` event, attached to the model request or turn span it happened in, and adds to the `oasis.recovery.count` counter. The event's `kind` is one of `connection_retry`, `provider_retry`, `rate_limit_wait`, `stream_restart`, `malformed_call`, `context_overflow` or `output_truncated`, and it carries the attempt number, the limit, the HTTP status and the wait where they apply. Secrets in provider error text are redacted.

| Variable | Effect |
| --- | --- |
| `OTEL_LOG_USER_PROMPTS=1` | Include prompt text in the `oasis.user_prompt` event. Off by default; only the length is sent. |
| `OTEL_LOG_TOOL_DETAILS=1` | Include tool arguments in tool events. Off by default. |
| `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` | Name spans as the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) do: `invoke_agent oasis`, `chat MODEL`, `execute_tool TOOL`. Without it span names stay `oasis.turn`, `oasis.llm_request` and `oasis.tool`, so existing dashboards keep working. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_HOST_NAME=1` | Resource attributes. |
| `OASIS_OTEL_NO_BRANCH=1` | Leave the git branch out of event attributes. |

Spans always carry the GenAI attributes (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.finish_reasons` as a string array, `gen_ai.usage.*` including cache and reasoning tokens, `server.address`/`server.port`, `error.type` on failure). Alongside the `oasis.*` metrics, OASIS records the standard `gen_ai.client.inference.duration` (seconds), `gen_ai.client.inference.operation.input_tokens` / `output_tokens` histograms with the recommended bucket boundaries, and `gen_ai.execute_tool.duration`. These GenAI metrics carry no session id so they stay low-cardinality.

### Trace context across processes

With telemetry on, one trace follows the work across process and protocol boundaries, in [W3C Trace Context](https://www.w3.org/TR/trace-context/) form:

| Boundary | What OASIS does |
| --- | --- |
| Started by something that traces (CI, a script, another agent) | `TRACEPARENT` and `TRACESTATE` in OASIS's environment, the [OpenTelemetry environment carrier](https://opentelemetry.io/docs/specs/otel/context/env-carriers/), make each turn a child of the caller's span. |
| Commands it runs (`run_command`, `run_shell`, background commands) | The child process gets `TRACEPARENT`/`TRACESTATE` naming the tool span that started it, so a nested `oasis -p` or any OpenTelemetry-instrumented program lands under that tool call. |
| MCP tool calls | `params._meta.traceparent` (and `tracestate`), as in [MCP SEP-414](https://modelcontextprotocol.io/seps/414-request-meta). `oasis mcp serve` reads it back: each call becomes a SERVER span under the client's `execute_tool` span, and commands it runs inherit that trace. |
| Model API requests | A `traceparent` header naming the model-call span, so a tracing gateway or proxy (LiteLLM, Envoy, a provider's own tracing) joins the trace. A `traceparent` set by custom headers wins. |

Nothing is added while telemetry is off: requests are byte-for-byte what they were, and an inherited `TRACEPARENT` passes through to commands unchanged. Invalid values (all-zero ids, version `ff`, upper-case hex) are ignored.

`OASIS_OTEL_ENV_CONTEXT` chooses how an inherited `TRACEPARENT` is used: `parent` (default), `link` (each turn starts a new trace that links to the caller's span, for long-running processes such as `oasis web` where one inherited parent would make a single endless trace) or `off`. The choice mirrors the open [parent-or-link question](https://github.com/open-telemetry/opentelemetry-specification/issues/5398) in the OpenTelemetry specification.
