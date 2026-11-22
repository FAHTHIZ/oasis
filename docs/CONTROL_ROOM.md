# Control room

The control room shows every agent on this computer in one place: what each one is doing, its own screen and browser, what happened recently, how many tokens it used and how loaded the machine is. Open it in the web app with the robot button in the top bar (or "Open control room" in the command palette), or in a terminal:

```bash
oasis control-room            # once
oasis control-room --watch    # refreshes every 2 seconds
oasis control-room --hours 72 --json
```

## What it shows

| Section | Contents |
| --- | --- |
| Headline | Agents working (here and in other OASIS windows), approvals waiting for you, open screens and browsers, tokens and estimated cost in the window (24 hours by default), and the machine's load and memory |
| Agents | Each subagent, background agent and team member: its task, type, status, run time, tool calls, tokens, model, and whether it has its own desktop, a worktree or read-only access. Children are indented under their parent. A Stop button stops a running agent in the web server's own sessions, together with its screen and browser |
| Screens and browsers | Virtual screens (with the VNC address to watch them) and browser tabs held by the main agent or by subagents with [their own environment](COMPUTER_USE.md#agent-environments). Idle ones are marked before they close |
| History | Agents starting, finishing, failing and being stopped, newest first |
| Sessions | Sessions that ran agents in the window, with their agent count and spend |
| This computer | CPUs, load average, memory, and the OASIS server's own memory use |

## Where the data comes from

Every OASIS process (the terminal, the web app, chat gateways, `oasis a2a serve`) writes each agent's start, state changes and token charges to the [agent ledger](OASIS-NEURON-NETWORK.md#network-ledger), a small SQLite file in the OASIS config folder (`~/.config/oasis/sessions/neuron-ledger.sqlite` on Linux and macOS, `%APPDATA%\oasis\sessions` on Windows). The control room reads that file, so it sees agents started from a terminal while you look at the web app, and agents of processes that have exited. Screens, browsers, approvals and Stop are only known for sessions open in the web server you are looking at.

The ledger has no heartbeat. An agent still marked running in another process with no activity for 30 minutes is shown as "No recent activity": usually that process was killed. When it restarts the session, OASIS marks the agent interrupted.

Only lifecycle facts and short task descriptions are shown, never prompts, model output or tool results. The web view needs the same access token as the rest of the web app. The ledger keeps 30 days. `OASIS_NEURON_LEDGER=0` turns it off; the control room then shows only the web server's own sessions.
