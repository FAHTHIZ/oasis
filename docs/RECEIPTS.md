# Receipts

An agent's reply says what it did. A receipt proves it. A receipt is a signed
JSON file holding what a run actually did: the tool events, the checks and their
exit codes, the files it changed, and what backs each claim in the reply. Anyone
with the file can check it, and with `--replay` they can rerun the checks on
their own machine. They do not have to trust the reply, the model or the person
who sent it.

## Writing a receipt

```sh
oasis -p "fix the failing date test" --receipt fix.receipt.json
```

In an interactive session, `/receipt [FILE]` writes one for the session so far.
For a session that is already saved, `oasis receipt create --session ID -o FILE`
(or `--last` for the most recent one) writes it after the fact.
If you give no file name, it writes `oasis-receipt-<time>.json` in the workspace.

Headless JSON output reports the file under `receipt`, or the reason it could not
be written under `receipt_error`. A failed receipt never fails the run.

## Checking a receipt

```sh
oasis receipt verify fix.receipt.json            # signature, chain, claims, files
oasis receipt verify fix.receipt.json --replay   # also rerun the recorded checks
oasis receipt verify fix.receipt.json --trust ed25519:0123...   # pin the signer
oasis receipt verify fix.receipt.json --json     # machine-readable verdict
oasis receipt show fix.receipt.json              # one-screen summary
oasis receipt create --last -o last.json          # receipt for the latest saved session
oasis receipt key                                # this machine's signing key id
```

`verify` exits 0 only when the receipt holds. The statuses, from best to worst:

| Status | Meaning |
| --- | --- |
| `reproduced` | Verified, and every replayed check gave the recorded result again |
| `verified` | Signature, evidence chain and files all hold, and no claim is contradicted |
| `drifted` | The receipt is genuine, but files in the workspace changed after it was written |
| `unsupported` | The receipt is genuine, but the reply claims something its own evidence contradicts, such as "all tests pass" after a failing run |
| `failed_replay` | A replayed check no longer gives the recorded result |
| `untrusted_signer` | `--replay` was asked for, but the signer is neither this machine's key nor passed with `--trust`, so no command ran |
| `tampered` | The signature or the evidence chain does not match, or the signer is not trusted |
| `invalid` | Not an `oasis.receipt/v1` file |

## What is in it

| Field | Contents |
| --- | --- |
| `format`, `issuedAt`, `producer` | `oasis.receipt/v1`, the time it was written, the OASIS version |
| `subject` | Workspace name, plus git head, branch, whether it was dirty, and a digest of the uncommitted diff |
| `run` | Session id, model, request and reply (secrets redacted), and the task intent, risk and verdict if available |
| `evidence` | Every tool event from the evidence ledger (`src/evidence-ledger.mjs`), linked in a SHA-256 hash chain; `head` is the last link. A command or check event carries `changed`: the files it was observed to change ([effect contracts](EFFECTS.md)), up to 30, left out when another command ran in the same tree at the same time. A command that was [rehearsed](REHEARSAL.md) carries `rehearsal`: `applied` (the rehearsed changes were landed without a second run), `matched`, `diverged` (with `unrehearsed`, the files the real run changed beyond what the rehearsal showed) or `incomplete` (the rehearsal timed out or could not run). `oasis receipt verify` reports these on a `rehearsals` line, as a warning when any diverged |
| `claims` | Each checkable statement in the reply, its status (observed, calculated, reported, inferred, unverified, contradicted) and the event numbers that back it. See [claims](TASK-MODEL.md#claims) |
| `files` | Each file edited by a tool or observed changing under a command (a formatter, a code generator, `sed -i`, a snapshot update), and the SHA-256 of its content when the receipt was written; a deleted file is recorded as missing |
| `replay` | The latest finished, unmasked run of each check after the last edit, and whether it passed |
| `signature` | Ed25519 over the canonical JSON of everything else, with the public key and key id |

Canonical JSON sorts keys at every depth, so the signature does not depend on
key order. Each chain link is `sha256(previous link + canonical event)`, starting
from 64 zeros. Removing, reordering or editing an event breaks every link after it.

## Keys and trust

Each machine signs with its own key at `<config dir>/receipts/signing-key.pem`,
created the first time it is needed and stored with mode 0600. The key id is
`ed25519:` followed by the first 32 hex digits of the SHA-256 of the public key.
A valid signature only shows that the receipt has not changed since it was
signed. To trust who signed it, pin the key: `--trust KEY_ID`, repeated for each
key you accept. A CI runner can publish its key id once, so reviewers can pin it.

## In GitHub Actions

The [GitHub Action](../action.yml) writes a receipt for every run unless you set
`receipt: false`. It writes the file to `RUNNER_TEMP`, never into the checkout, so
the receipt is never committed. The action checks the receipt, puts the verdict in
its comment, uploads the file as the `oasis-receipt` artifact and sets the
`receipt` and `receipt_status` outputs.

A runner is new for each job, so without a key each run signs with a new key.
To give CI a stable identity that reviewers can pin:

```sh
oasis receipt key --new | gh secret set OASIS_RECEIPT_KEY   # prints the key id as a comment
```

```yaml
- uses: FAHTHIZ/oasis@main
  with:
    api_key: ${{ secrets.OASIS_API_KEY }}
    receipt_signing_key: ${{ secrets.OASIS_RECEIPT_KEY }}
```

The action keeps the key in memory and removes it from the environment before the
agent starts, so no command the agent runs can read the key and sign a forged
receipt. Anyone can then check a downloaded receipt with
`oasis receipt verify FILE --trust KEY_ID --replay`.

On your own machine the key is a file the agent could read with its shell. A
local receipt shows that the record has not changed since it was signed and that
its claims match its evidence. It does not protect you from an agent that you
let read your config directory.

## Replay safety

`--replay` runs commands from the receipt in your workspace, with a time limit
for each. The public key travels inside the receipt, so anyone can make a
receipt with a valid signature: a valid signature alone shows only that the
receipt has not changed since that key signed it. Replay therefore runs
commands only when the signer is trusted, either because it is this machine's
own receipt key or because you named it with `--trust KEY_ID`. Otherwise the
status is `untrusted_signer` and nothing runs. It also refuses to run anything
from a receipt whose signature fails. Even for trusted signers, prefer a clean
checkout or a container: the commands run with your environment.

Without `--trust`, a receipt signed by a key other than this machine's still
verifies, but `verify` shows a `signer` warning and says that the signer is not
trusted.

## Sessions

Saved sessions keep their evidence ledger (the last 500 events), so after
`oasis --resume` both receipts and the task gate still see what earlier turns ran.
