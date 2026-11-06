#!/usr/bin/env bash
# Runs OASIS's MCP client against the official conformance suite's client scenarios.
# usage: scripts/mcp-conformance/run.sh [scenario ...]   (default: every scenario in scenarios.txt)
# Needs git and network access; the suite is cloned into $CONFORMANCE_DIR (default .cache/mcp-conformance).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dir=${CONFORMANCE_DIR:-$here/../../.cache/mcp-conformance}
ref=${CONFORMANCE_REF:-main}
if [ ! -d "$dir/.git" ]; then git clone --depth 1 --branch "$ref" https://github.com/modelcontextprotocol/conformance.git "$dir"; fi
(cd "$dir" && [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null)
if [ $# -gt 0 ]; then scenarios=("$@"); else mapfile -t scenarios < "$here/scenarios.txt"; fi
pass=0; total=0
for s in "${scenarios[@]}"; do
  total=$((total + 1))
  out=$(cd "$dir" && timeout 120 npx tsx src/index.ts client --command "node $here/oasis-client.mjs" --scenario "$s" --timeout 40000 2>&1 || true)
  line=$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^Passed:' | head -1 || true)
  notes=$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'FAILURE|WARNING' | head -3 | tr '\n' ' ' || true)
  case "$line" in *", 0 failed"*) pass=$((pass + 1));; esac
  printf '%-48s %s %s\n' "$s" "${line:-NO RESULT}" "$notes"
done
echo "scenarios passed: $pass/$total"
