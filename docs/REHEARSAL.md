# Command rehearsal

An approval prompt for a command used to show the command line and nothing else. Whether `python3 gen.py`, `make`, `npm run build` or `tar xf bundle.tar` touches two files or two hundred was a guess. With rehearsal on, OASIS runs the command once in a throwaway copy-on-write view of the workspace first, and the prompt lists the files it would create, modify and delete, measured, not predicted:

```text
Run this command in the workspace?
  python3 "gen.py"
Rehearsal (network off, nothing kept): exit 0 in 89 ms.
  would create (3): generated/m0.py, generated/m1.py, generated/m2.py
```

It is on by default when the OS sandbox runs on bubblewrap (`"sandbox": { "enabled": true }` on Linux): there the only commands that still prompt are the high-risk ones, where the exact change list matters most. Elsewhere turn it on with `OASIS_REHEARSE=1` or `"rehearse": true` in your own settings; `OASIS_REHEARSE=0` or `"rehearse": false` turns it off. A repository's settings can turn it off but not on, since a rehearsal starts the command before anyone approved it. It applies to `run_command` and `run_shell` calls that need approval. Linux only; elsewhere, and when bubblewrap cannot mount an overlay, prompts look as before.

Under the sandbox, the rehearsal also hides the sandbox's own masks (`sandbox.filesystem.denyRead`), so it sees no more than the real run.

## How it works

bubblewrap (0.11 or later) mounts an overlay on the workspace path. The real workspace is the read-only lower layer and a private directory is the upper layer, so every write lands in the upper layer. Around it:

- the rest of the file system is read-only and `/tmp` is a fresh tmpfs;
- the network, PID, IPC and UTS namespaces are private (no network unless `oasis rehearse --network`);
- `/run`, `/var/run`, `/dev/shm` and `$XDG_RUNTIME_DIR` are empty, and where the seccomp helper from `@anthropic-ai/sandbox-runtime` is present, Unix sockets cannot be opened at all, so host daemons (Docker, an SSH agent, D-Bus) are out of reach;
- the command is stopped after 30 seconds and reports what it changed so far.
- the command has not been approved yet, so it sees no more than a sandboxed command would: the credential folders and files the OS sandbox hides (`~/.ssh`, `~/.aws`, `~/.netrc`, `~/.config/oasis` and the rest) are empty, and secret environment variables are removed as for a real run. Otherwise it could read a key and put it into the name of a file it creates, and that name goes into the prompt and the tool result the model sees.

When the command exits, the upper layer is the exact change set: a file or symlink is created, or modified when it differs from the lower one (content, mode or link target); a character device 0/0 is a whiteout, so the path was deleted. A directory that replaced a lower one (`rm -r d; mkdir d`) is opaque; instead of reading overlay extended attributes, a small helper lists the merged directory from inside the sandbox before it exits, and the names missing from it were deleted. Changes inside `.git` are counted separately.

After the person approves, the command runs for real as before. Effect contracts ([EFFECTS.md](EFFECTS.md)) observe what it actually changed. If it changed a file its rehearsal did not show, the result carries `rehearsal.divergence` naming those files and the session log records a `rehearsal_divergence` event: the person approved one thing and the command did another (clocks, randomness, the network).

Rehearsal never runs a command held because of suspected prompt injection, and is skipped when commands go to SSH or a container, where the overlay would not be the place the command runs. The home directory and `/` are never rehearsed as the workspace.

## By hand: `oasis rehearse`

```sh
oasis rehearse -- npm run build
oasis rehearse --shell 'find . -name "*.orig" -delete'
oasis rehearse --apply -- python3 scripts/migrate.py
```

`--apply` copies the rehearsed changes into the workspace instead of running the command a second time, so what lands is exactly what was shown. Before writing anything it re-checks every path the rehearsal touched (content and mode); if any of them changed since, it applies nothing and names them. It refuses to apply changes inside `.git`. Exit status is 0 when the rehearsed command exited 0 (and the apply succeeded), 1 otherwise, 2 when rehearsal is unavailable. `--json` prints the result as JSON.

## Measured

`node scripts/rehearsal-bench.mjs` runs 16 commands three ways on identical fresh fixtures: for real (ground truth), rehearsed, and through the static prediction effect contracts make from the command line. Results on Linux 6.1, bubblewrap 0.11.1, Node 22.21:

| Command | Files really changed | Static prediction | Static exact | Rehearsal exact | Real ms | Rehearsal ms |
| --- | --- | --- | --- | --- | --- | --- |
| sed-in-place | 1 | covers | yes | yes | 3 | 118 |
| redirect | 1 | covers | yes | yes | 13 | 70 |
| append | 1 | covers | yes | yes | 7 | 65 |
| rm-tree | 2 | covers | no | yes | 2 | 65 |
| mv-rename | 2 | covers | yes | yes | 3 | 43 |
| cp-into-dir | 1 | covers | no | yes | 14 | 39 |
| git-checkout-dot | 1 | covers | no | yes | 24 | 62 |
| tar-extract | 2 | broad | no | yes | 2 | 47 |
| python-generator | 3 | broad | no | yes | 30 | 89 |
| node-formatter | 2 | broad | no | yes | 32 | 83 |
| find-delete | 2 | covers | no | yes | 9 | 46 |
| xargs-sed | 2 | broad | no | yes | 28 | 57 |
| make-build | 1 | broad | no | yes | 7 | 48 |
| npm-script | 3 | broad | no | yes | 142 | 171 |
| random-content | 1 | broad | no | yes | 27 | 60 |
| timestamped-name | 1 | broad | no | no | 20 | 79 |

The static prediction gives an exact file list for 4 of 16 commands and says "broad" (cannot tell) for 8. Rehearsal gives the exact file list for 15 of 16, at a median cost of about 50 ms over running the command. The miss is honest: a command that names its output after the clock writes `build-<time>.txt` with a different name each run, and the post-run divergence check reports exactly that file.

The benchmark also found a gap in the static prediction: before this change it predicted that `find … -delete`, `… | xargs sed -i` and `npm run build` change nothing at all, so their real changes were flagged as unexpected. They are now bounded (`find -delete` to its start points) or marked broad (`find -exec`, `xargs` with a writing command, package scripts, `perl` without `-i`).

## Limits

- Effects outside the file system are not rehearsed: the network is off, so a command that downloads fails in rehearsal (the prompt says so) and a command that talks to a server has not talked to it.
- Writes outside the workspace are refused in rehearsal (read-only); the prompt says when the command tried. The real run may succeed there.
- A command can still read files the user can read. Without network or sockets it cannot send them anywhere during the rehearsal, but rehearsal does run unapproved code, which is why it is off by default. With rehearsal on, treat the approval prompt as "run this, isolated, then decide", the same trust boundary as `sandbox.autoAllowCommands` with the OS sandbox.
- Non-deterministic commands can differ between rehearsal and the real run; the divergence check catches the file-level difference, not differences in content.
- Large copy-ups cost what they cost: modifying a 1 GB file copies it into the upper layer.

## Compared with other tools

[try](https://github.com/binpash/try) (binpash) introduced running a shell command over an overlay and committing the upper directory; OASIS takes the same file-system idea. The differences are in what surrounds it: try is explicitly not a sandbox (network is on unless `-x`, host sockets are reachable), its commit does not check whether live files changed since the run, and it reads opaque-directory markers through `user.overlay` extended attributes. Rehearsal here is network-less and socket-less by default, its apply is conflict-checked, it needs no xattr tools, and it is built into the agent's approval flow with a post-run check against the observed effects. Tool-specific dry runs (`make -n`, `rsync --dry-run`, `terraform plan`, `git apply --check`) are exact for their own tool and say nothing about arbitrary programs; Claude Code and Codex checkpoints restore files after the fact rather than showing effects before approval ([Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)). Overlay semantics: [Linux overlayfs documentation](https://docs.kernel.org/filesystems/overlayfs.html); [bubblewrap](https://github.com/containers/bubblewrap) (overlay options since [0.11.0](https://github.com/containers/bubblewrap/blob/main/NEWS.md); not available when bubblewrap is installed setuid).

`/insights` (and `oasis insights`) counts commands whose real run changed more than their rehearsal, per command, and suggests reviewing a command from its text when its rehearsal misses repeatedly.
