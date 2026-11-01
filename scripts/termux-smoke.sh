#!/data/data/com.termux/files/usr/bin/bash
set -eu

case "${PREFIX:-}" in
  /data/data/com.termux/files/usr) ;;
  *)
    echo "This smoke check must run inside Termux (PREFIX=/data/data/com.termux/files/usr)." >&2
    exit 2
    ;;
esac

if [ ! -f package.json ] || [ ! -f src/cli.mjs ]; then
  echo "Run this script from the root of an OASIS repository checkout." >&2
  exit 2
fi

node_major="$(node -p 'Number.parseInt(process.versions.node.split(".")[0], 10)')"
if [ "$node_major" -lt 22 ]; then
  echo "OASIS needs Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

echo "Termux: ${TERMUX_VERSION:-version not reported}"
echo "Android architecture: $(uname -m)"
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "Installing production dependencies in this checkout..."
npm install --omit=dev --no-audit --no-fund

echo "Checking CLI startup..."
node src/cli.mjs --version
echo "Checking OASIS environment..."
node src/cli.mjs doctor

echo "Checking the isolated workflow runtime..."
node --input-type=module -e 'import { getQuickJS } from "quickjs-emscripten"; await getQuickJS(); console.log("QuickJS workflow runtime: available");'

echo "Checking optional native PTY support..."
if node --input-type=module -e 'await import("node-pty")' >/dev/null 2>&1; then
  echo "Native PTY: available"
else
  echo "Native PTY: unavailable (optional; ordinary CLI execution remains usable)"
fi

echo "Termux smoke check completed. No model provider was contacted."
