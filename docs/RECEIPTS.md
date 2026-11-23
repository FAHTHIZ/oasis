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
| `tampered` | The signature or the evidence chain does not match, or the signer is not trusted |
| `invalid` | Not an `oasis.receipt/v1` file |

## What is in it

| Field | Contents |
| --- | --- |
| `format`, `issuedAt`, `producer` | `oasis.receipt/v1`, the time it was written, the OASIS version |
| `subject` | Workspace name, plus git head, branch, whether it was dirty, and a digest of the uncommitted diff |
| `run` | Session id, model, request and reply (secrets redacted), and the task intent, risk and verdict if available |
| `evidence` | Every tool event from the evidence ledger (`src/evidence-ledger.mjs`), linked in a SHA-256 hash chain; `head` is the last link |
| `claims` | Each checkable statement in the reply, its status (observed, calculated, reported, inferred, unverified, contradicted) and the event numbers that back it. See [claims](TASK-MODEL.md#claims) |
| `files` | Each changed file and the SHA-256 of its content when the receipt was written |
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

## Replay safety

`--replay` runs commands from the receipt in your workspace, with a time limit
for each. It refuses to run anything from a receipt whose signature fails.
Replay receipts only from signers you trust, and preferably in a clean checkout
or a container.

## Sessions

Saved sessions keep their evidence ledger (the last 500 events), so after
`oasis --resume` both receipts and the task gate still see what earlier turns ran.
