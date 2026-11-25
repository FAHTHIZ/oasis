# First-party OASIS ecosystem

OASIS is the agent runtime. It owns the task loop, sessions, tools, subagent
orchestration, permissions and verification. Two first-party companion projects
extend it without merging their runtimes or deployment lifecycles:

| Project | Responsibility | Connection to OASIS |
| --- | --- | --- |
| [EXTREMIS](https://github.com/FAHTHIZ/EXTREMIS) | Capability discovery, planning, progressive activation, specialist profiles, tools and verification | Optional MCP server plus an Agent Skills gateway skill |
| [OASIS Route](https://github.com/FAHTHIZ/OASIS-ROUTE) | Authorized upstream provider connections, spend policy, quota reservations, inference routing and failover | Optional OpenAI-compatible inference endpoint; native terminal provider shipped in OASIS v0.12.0 |

Both projects are separately versioned and deployed. Neither is required to
run OASIS, and neither replaces the OASIS agent runtime.

## EXTREMIS: capability discovery and activation

[EXTREMIS](https://github.com/FAHTHIZ/EXTREMIS) is a capability layer and skill
finder for agent hosts. Its current catalogue includes:

- 64 Agent Skills and 6 multi-step workflows across 16 domains.
- 10 specialist-agent profiles, including code review, security auditing,
  debugging, research, data analysis, AI engineering, architecture and product
  strategy.
- 45 built-in tools for tasks such as data profiling, SQL, code and security
  checks, API diffs, CI analysis and LLM evaluation.
- Progressive discovery and activation: inspect a compact catalogue, plan the
  task, then load only the selected instructions and tool schemas.
- A federated finder for public skills, plus executable verification checks.

EXTREMIS does not supply a model or take over the host's agent loop. Its
specialist agents are reusable profiles/prompts, not separate OASIS processes.
OASIS continues to schedule and execute its own subagents and retain control of
the session and permission boundary.

### Connect EXTREMIS to OASIS

From the project directory where you want to use it:

```sh
oasis mcp add extremis -- npx -y github:FAHTHIZ/EXTREMIS mcp
npx skills add FAHTHIZ/EXTREMIS
```

The first command registers EXTREMIS's MCP gateway. The second installs its
Agent Skills gateway skill, which teaches the model when to use the MCP tools.
The gateway exposes a compact set of EXTREMIS operations and specialist-agent
prompts; EXTREMIS's wider built-in tool catalogue is accessed through that
gateway according to its configuration.

Check the registrations with:

```sh
oasis mcp list
oasis skills list
```

Start a fresh OASIS session after adding the server and skill. See the
[EXTREMIS README](https://github.com/FAHTHIZ/EXTREMIS#readme) for its CLI,
JavaScript and Python integrations, capability catalogue and full configuration.

**Execution boundary.** OASIS runs MCP servers as ordinary processes outside
its OS command sandbox. EXTREMIS has its own permission checks and installation
scanner, but those are not an operating-system sandbox or proof that arbitrary
third-party skills are safe. Review the project and its capabilities before
enabling them, and use OASIS's sandbox or a separate environment for untrusted
code. See [Extending OASIS](EXTENDING.md#mcp-servers) for OASIS's MCP trust
model and [EXTREMIS security notes](https://github.com/FAHTHIZ/EXTREMIS/blob/main/docs/security.md).

## OASIS Route: inference routing

[OASIS Route](https://github.com/FAHTHIZ/OASIS-ROUTE) is the first-party,
self-hosted inference gateway. It manages provider connections, eligibility
and spend policy, quota reservations, model selection and failover. It does
not execute OASIS tasks or tools; OASIS remains the agent runtime.

The native terminal `oasis-route` provider and setup choice shipped in
[OASIS v0.12.0](https://github.com/FAHTHIZ/oasis/releases/tag/v0.12.0).
Use **OASIS Route** in `oasis setup`, or connect using the standard
OpenAI-compatible endpoint.

### Run Route locally

From a clone of the Route repository:

```sh
uv sync
uv run oasis-route dev --port 8081
```

The development server prints an Oasis Key and stores it in
`.oasis-dev/admin.key`; the second line is the bearer token. Connect at least
one upstream provider you are authorized to use in the Route console. The
built-in mock providers make a new installation testable, but they do not
provide real upstream inference capacity.

Then point the OASIS terminal runtime at Route:

```sh
export OASIS_ROUTE_API_KEY="$(sed -n 2p .oasis-dev/admin.key)"
export OASIS_BASE_URL="http://127.0.0.1:8081/v1"
export OASIS_MODEL="auto"
oasis
```

If Route is on a different host or port, use its reachable `/v1` endpoint and
configure `OASIS_PROVIDER_OASIS_ROUTE_BASE_URL` as described in
[Configuration](CONFIGURATION.md#oasis-route-gateway). Keep a local development
instance bound to loopback. For production, configure PostgreSQL, the master
key and API-key pepper, HTTPS and a protected reverse proxy; follow Route's
[deployment guide](https://github.com/FAHTHIZ/OASIS-ROUTE/blob/main/docs/DEPLOYMENT.md).

### Spend-policy boundary

Route's `free_only` policy is enforced by Route itself. OASIS
`--zero-budget` does not infer the downstream billing behavior of an arbitrary
gateway, even when that gateway is OASIS Route. These are separate protections:
do not assume that setting one automatically configures or proves the other.
