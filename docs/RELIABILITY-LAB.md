# Reliability laboratory

OASIS claims to survive rate limits, dropped connections, broken provider
replies and tool failures. The reliability laboratory checks those claims by
running real agent turns while the runtime is broken on purpose, then grading
the workspace rather than the transcript.

```sh
node scripts/reliability-lab.mjs            # scorecard; exit 1 if any scenario fails
node scripts/reliability-lab.mjs --compare  # also run with live reconciliation off
node scripts/reliability-lab.mjs --json lost-reply-append-command
```

## Fault injection

`src/fault-injection.mjs` reads `OASIS_FAULTS` and makes the runtime itself
misbehave at chosen moments. Nothing changes unless the variable is set.

```sh
OASIS_FAULTS="model:429@1,model:reset@2,tool:run_command:lost-reply@1" oasis -p "..."
OASIS_FAULTS_SEED=7   # for probabilistic schedules such as @p0.25
```

| Target | Faults | What happens |
| --- | --- | --- |
| `model:` | `429`, `500`, `502`, `503`, `529` | The model request gets that HTTP error, with `retry-after-ms: 1`. |
| | `reset` | The connection drops before a response (`ECONNRESET`, as undici reports it). |
| | `truncate`, `garbage`, `empty` | A 200 whose body is cut in half, is not JSON, or has no message. |
| | `malformed-args` | Tool-call arguments arrive as broken JSON. |
| `tool:<name or *>:` | `error` | The call fails before it runs (`EIO`). |
| | `lost-reply` | The call runs, then its result is lost: the work happened but the agent is told it failed. |
| | `slow` | The call waits 1.5 s, then runs. |

Schedules count calls per target: `@3` (third call), `@2-4`, `@every3`,
`@p0.25` (seeded, reproducible), or nothing for every call. Each injected
fault is kept in `faultLog()` and, with telemetry on, sent as an
`oasis.fault_injected` event, so a trace shows the fault next to the recovery.

## Scenarios

`src/reliability-lab.mjs` runs each scenario in a fresh git work tree against a
local, deterministic model that stands in for a careful one: it works through
a fixed plan of tool calls, retries a step whose result reports an error, and
moves on when the result says the failed step already took effect. A scenario
fails only when OASIS itself loses work, repeats a side effect, gives up on a
recoverable fault, or hides what happened. The graded outcome is the files on
disk (including a log that a command appends to, which shows duplicates).

The fifteen scenarios cover a clean run, each model fault, tool failures
before running, slow tools, lost replies on an idempotent write and on a
non-idempotent command, and a mixed storm of four faults in one turn.

Three more scenarios cover [command rehearsal](REHEARSAL.md) with a stand-in
person answering the approval prompt (they need bubblewrap 0.11 with overlay
support and are reported as skipped elsewhere). A command writes a file named
after the time and a random number, so its rehearsal and its real run never
agree:

- `rehearsal-divergence-reported`: the person answers yes; the real run's file
  differs from the rehearsed one, and the result must name it as unrehearsed.
- `rehearsal-applied-as-shown`: the person picks "apply the rehearsed changes";
  exactly the file the rehearsal showed must land, with no second run.
- `rehearsal-conflict-then-retry`: someone edits the command's target while the
  prompt is open, then the person picks apply. Nothing may be applied over the
  edit, and the stand-in model's retry must land the change once.

## What it found

The first run passed 10 of 15 scenarios. Three weaknesses were real:

1. A 200 response whose body was cut off or replaced by a proxy's error page
   ended the task with "returned invalid JSON". It is now retried like an
   interrupted stream (at most two restarts, so a misconfigured endpoint still
   fails with the same message).
2. A 200 response with no message ended the task the same way; same fix.
3. A command whose result was lost after it ran was repeated by the model,
   appending the log line twice. Crash recovery already knew how to tell
   whether an action took effect (the [intent journal](DURABLE-EXECUTION.md)
   probes and the [effect contract](EFFECTS.md) observation), but only after a
   restart. Live reconciliation now runs those checks the moment a
   consequential call fails: when its targets show it took effect, the error
   result carries an `afterFailure` verdict (`applied`, `partial` or
   `changed`, with findings) and the note "Check the result before repeating
   it; repeating may do it twice." Failures that changed nothing get no note,
   and a change made while another command ran at the same time is flagged as
   possibly that command's. `OASIS_AFTER_FAILURE_CHECK=0` turns it off.

The rehearsal scenarios found a fourth: the effect snapshot for a command was
taken before its approval prompt, so a file someone edited while the prompt was
open was reported as the command's change. In `rehearsal-conflict-then-retry`
the refused apply then got an `afterFailure` note saying the command "probably
ran", and the model did not retry (the change never landed). The snapshot is
now re-taken once the call is approved (`rebaseEffectObservation`), which also
keeps such edits out of the divergence check and out of `/rewind`'s preimages.

After the fixes all 15 of the original scenarios pass, and all 18 with the
rehearsal scenarios. The ablation (`--compare`) on the same scenarios:

| | Scenarios passed | Duplicated side effects | Model requests, lost reply on a write |
| --- | --- | --- | --- |
| Live reconciliation on | 15 of 15 | 0 | 3 |
| `OASIS_AFTER_FAILURE_CHECK=0` | 13 of 15 | 2 | 5 |

`test/fault-injection.test.mjs` keeps the bad-body, empty-reply and
lost-reply scenarios, and the ablation, in the test suite.

## Limits

- The stand-in model is cooperative and deterministic. Real models may ignore
  an `afterFailure` note or retry anyway; the lab measures what the runtime
  tells the model, not what a given model does with it.
- `malformed-args` rewrites non-streaming JSON replies only; streamed replies
  pass through unchanged.
- Live reconciliation can only see what its probes see: files in the
  workspace and git `HEAD`. For an API call or a remote service, the verdict is
  absent, as it is after a crash.
- Effect observation needs a git work tree.

## References

- Netflix, [Chaos Engineering](https://netflixtechblog.com/tagged/chaos-engineering) and the [Principles of Chaos Engineering](https://principlesofchaos.org/): experiment on the running system and measure steady state, not component tests.
- Temporal, [Activities](https://docs.temporal.io/activities): activities may run more than once after a failure, so they must be idempotent or checked; live reconciliation applies the check to tools that are not idempotent.
- Gray and Reuter, [Transaction Processing](https://dl.acm.org/doi/10.1145/128765.128770): in-doubt transactions are resolved by asking the resource, not by guessing.
