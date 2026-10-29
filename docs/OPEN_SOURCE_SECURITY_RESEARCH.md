# Open-source security components research

**Research date:** October 29, 2026  
**Scope:** command authorization, shell parsing, and operating-system sandboxing in OASIS.

## Anthropic Sandbox Runtime

Repository: https://github.com/anthropics/sandbox-runtime  
Package reviewed: `@anthropic-ai/sandbox-runtime@0.0.81`  
License: Apache-2.0  
Node engine in the reviewed manifest: `>=22.12.0`

The upstream project adds OS-enforced filesystem restrictions and network policy on top of application-level permissions. Its README describes macOS Seatbelt, Linux bubblewrap plus network mediation, and a Windows implementation marked alpha. The upstream project explicitly calls itself a beta research preview and says APIs/configuration can evolve. See the [upstream README](https://github.com/anthropics/sandbox-runtime#readme).

**Decision:** use this as the primary reference for a later OASIS sandbox adapter, not as an unreviewed drop-in replacement. The reviewed manager has module-level configuration and proxy state, while OASIS can run concurrent sessions and workspaces. A safe integration must prove policy isolation between commands, map OASIS settings into a validated configuration, keep approvals separate from containment, clean up settings and processes, and fail closed when an explicitly requested sandbox cannot be launched. It must also test PTY/background commands and platform-specific behavior independently. Do not advertise upstream feature parity until those tests exist.

## shell-quote

Repository: https://github.com/ljharb/shell-quote  
Version reviewed: `1.12.0`  
License: MIT

The package recognizes common POSIX shell operators and quoting forms. Its own documentation specifies that command substitution and arithmetic are not interpreted and that its quoting output is POSIX-only, not suitable for Windows command interpreters. See the [upstream README](https://github.com/ljharb/shell-quote#readme).

**Decision:** do not treat this parser alone as an authorization engine. OASIS should preserve a conservative, fail-closed policy for command substitutions, process substitutions, redirects and ambiguous shell syntax. A parser may improve tokenization and fuzz coverage, but policy matching still needs explicit rules and adversarial tests.

## OpenAI Codex

Repository: https://github.com/openai/codex  
License: Apache-2.0

Codex is a useful public architecture and threat-model reference for keeping command approvals and OS sandboxing as distinct controls. Rewriting OASIS's runtime in another language or copying large pieces of another agent would be a distraction from the concrete reliability and security defects already in the project.

## Concrete OASIS authorization issue

A source review found that `PreToolUse` could return `updatedInput` after the permission policy had already been evaluated. OASIS then carried forward the original `allow` decision to the rewritten action. The fix re-evaluates the final merged arguments, honors a matching deny rule, and preserves an existing explicit ask. New integration tests cover a rewritten action that must be re-approved and one that must be denied. The result is only considered verified when current GitHub Actions passes on the exact commit.

## Safe integration gates

1. Keep permission decisions and OS isolation as separate controls.
2. Avoid shared singleton sandbox state across concurrent sessions unless isolation is demonstrated.
3. Validate sandbox configuration and trust boundaries before launch.
4. Test denied network access, secret-file isolation, PTY/background execution, cancellation, startup failure and cleanup.
5. Keep unsupported or failed sandbox paths clearly visible; do not silently claim that an unsandboxed command was contained.
