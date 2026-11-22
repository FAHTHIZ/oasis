# A2A: OASIS and other agents

[Agent2Agent (A2A)](https://a2a-protocol.org) is an open protocol from the Linux Foundation ([a2aproject/A2A](https://github.com/a2aproject/A2A), Apache-2.0) that lets agents built with different frameworks hand work to each other. OASIS speaks it in both directions:

- `oasis a2a serve` makes OASIS an A2A agent that other agents can call (Google ADK, LangGraph, CrewAI, Microsoft Agent Framework, another OASIS...).
- The `remote_agent` tool lets OASIS delegate to remote A2A agents.

OASIS speaks A2A 1.0 and 0.3 over JSON-RPC. It was tested against the official [A2A Python SDK](https://github.com/a2aproject/a2a-python) 1.3 in both roles and both versions. Nothing extra is installed: the protocol is about 900 lines of OASIS's own JavaScript.

## Serving OASIS

```bash
cd my-project
oasis a2a serve                       # http://127.0.0.1:41241/
oasis a2a serve --port 9000 --permission-mode acceptEdits
```

It prints the Agent Card address, the JSON-RPC endpoint and a bearer token. Clients send `Authorization: Bearer <token>` with every request; set `OASIS_A2A_TOKEN` to choose the token yourself. The Agent Card at `/.well-known/agent-card.json` is public, as the spec requires, and lists OASIS plus your agents (built-in and [custom](SUBAGENTS.md)) as skills.

| A2A method (1.0) | 0.3 name | What OASIS does |
| --- | --- | --- |
| `SendMessage` | `message/send` | Runs one OASIS turn. It waits for the result unless `returnImmediately` (0.3: `blocking: false`) is set. |
| `SendStreamingMessage` | `message/stream` | The same, as Server-Sent Events: the task, text chunks as `artifactUpdate`, tool use as status updates, then the final status. |
| `GetTask`, `ListTasks` | `tasks/get`, `tasks/list` | Task state, the answer as an artifact, and the history. |
| `CancelTask` | `tasks/cancel` | Stops the running turn. |
| `SubscribeToTask` | `tasks/resubscribe` | Follow a running task's events. |

Push notifications and the extended Agent Card are not offered; those methods return the spec's errors.

Each A2A `contextId` is one OASIS session, so a client can hold a conversation: send the next message with the same `contextId`. Messages in one context run one at a time. Set `metadata.skill` (or `metadata.agent`) on the first message of a context to run it as one of your agents, for example `{"skill": "plan"}`. Idle conversations are closed after 30 minutes (`OASIS_A2A_CONTEXT_IDLE_MS`), and at most 32 are open at once (`OASIS_A2A_MAX_CONTEXTS`).

### Approvals and questions

Nobody sits at the terminal of a server, so when OASIS needs an approval, or asks a question, the task stops in `TASK_STATE_INPUT_REQUIRED` (`input-required` in 0.3). Its status message says what it wants to do. The client answers with a message on the same `taskId`: `yes` (or `allow`, `ok`) runs the action, anything else refuses it. Pick how much needs approval with `--permission-mode`: `default` asks for edits and commands, `acceptEdits` only for commands, `plan` is read-only, `auto` lets the safety classifier decide.

### Exposure

The server listens on `127.0.0.1` unless you pass `--host`. `--no-auth` drops the token and is only allowed on localhost. Anyone with the token can run OASIS in that folder with the permissions you gave it, so put a server that leaves your machine behind HTTPS (a reverse proxy) and set `--public-url` to the address clients use, so the Agent Card names it.

## Calling remote agents

Add agents to your user settings (`~/.oasis/settings.json`). A project's settings cannot add them, because a remote agent receives whatever OASIS sends it.

```json
{
  "a2aAgents": {
    "travel": "https://travel-agent.example.com",
    "reviewer": { "url": "http://127.0.0.1:9000", "tokenEnv": "REVIEWER_TOKEN", "description": "Our code review agent" }
  }
}
```

`token` sets the bearer token directly, `tokenEnv` names a variable that holds it, and without either OASIS uses `OASIS_A2A_TOKEN_<NAME>` (for `reviewer`, `OASIS_A2A_TOKEN_REVIEWER`). For one run, `OASIS_A2A_AGENTS="travel=https://...,reviewer=http://..."` does the same.

The model then has a `remote_agent` tool with these actions:

- `send` (the default): send a message and wait for the result. A `context_id` continues a conversation. If the remote agent answers `input-required`, OASIS replies with `task_id` set.
- `status` and `cancel` for a task.
- `card` reads the agent's skills.

The first message to each remote agent in a session asks you first. Subagents get the tool too and ask the same way. A remote task that takes longer than `OASIS_A2A_TIMEOUT_SECONDS` (default 600) comes back as still running, with its `task_id` to check later. `OASIS_A2A=0` turns the tool off, and `--restricted` never offers it.

From the shell:

```bash
oasis a2a card https://travel-agent.example.com
oasis a2a send http://127.0.0.1:41241 "Summarize the open TODOs in src/" --token "$TOKEN"
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OASIS_A2A_TOKEN` | random per start | Bearer token for `oasis a2a serve` |
| `OASIS_A2A_HOST`, `OASIS_A2A_PORT` | `127.0.0.1`, `41241` | Where the server listens |
| `OASIS_A2A_PUBLIC_URL` | the listen address | Address written in the Agent Card |
| `OASIS_A2A_CONTEXT_IDLE_MS` | 1800000 | Idle time before a conversation's session closes |
| `OASIS_A2A_MAX_CONTEXTS` | 32 | Open conversations at once |
| `OASIS_A2A_AGENTS` | none | `name=url,...` remote agents for this run |
| `OASIS_A2A_TOKEN_<NAME>` | none | Token for a remote agent without `token` or `tokenEnv` |
| `OASIS_A2A_CLIENT_TOKEN` | none | Token for `oasis a2a card` and `oasis a2a send` |
| `OASIS_A2A_TIMEOUT_SECONDS` | 600 | How long `remote_agent` waits for a remote task |
| `OASIS_A2A` | on | `0` hides the `remote_agent` tool |
