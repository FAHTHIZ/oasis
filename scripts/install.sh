#!/usr/bin/env sh
# What this script does:
# 1. Checks for Node.js 22 or newer.
# 2. Offers supported Node.js installation steps and asks before changing anything.
# 3. Installs the pinned OASIS v0.3.0 release in your user directory.
# 4. Runs oasis doctor and opens first-run provider setup.
# It does not request administrator rights, upload files, or send telemetry.
set -eu

OASIS_VERSION="v0.3.0"
OASIS_ARCHIVE="https://github.com/FAHTHIZ/oasis/archive/refs/tags/${OASIS_VERSION}.tar.gz"
OASIS_PREFIX="${OASIS_INSTALL_PREFIX:-$HOME/.local}"
OASIS_BIN="$OASIS_PREFIX/bin/oasis"
ASSUME_YES=0
SKIP_SETUP=0

for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --skip-setup) SKIP_SETUP=1 ;;
    --help|-h)
      printf '%s\n' "OASIS installer" "" "Usage: sh install.sh [--yes] [--skip-setup]" "" "--yes        Confirm prompts (intended for automated tests)." "--skip-setup  Run doctor without opening first-run setup (automated tests)."
      exit 0
      ;;
    *) printf 'I do not understand this option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$1"; }
ask_yes_no() {
  question=$1
  if [ "$ASSUME_YES" -eq 1 ]; then
    say "$question [approved by --yes]"
    return 0
  fi
  printf '%s [y/N] ' "$question"
  if [ ! -r /dev/tty ]; then
    say "I cannot ask for permission here, so I will not make this change."
    return 1
  fi
  answer=""
  IFS= read -r answer < /dev/tty || answer=""
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) say "Nothing was changed."; return 1 ;;
  esac
}
node_supported() {
  command -v node >/dev/null 2>&1 || return 1
  major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  [ "$major" -ge 22 ] 2>/dev/null
}
install_node_if_approved() {
  if command -v pkg >/dev/null 2>&1 && [ -n "${PREFIX:-}" ]; then
    say "Node.js 22 or newer was not found. This looks like Termux on Android."
    if ask_yes_no "May I run 'pkg install nodejs'?"; then pkg install nodejs; else exit 1; fi
  elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    say "Node.js 22 or newer was not found. Homebrew is available on this Mac."
    if ask_yes_no "May I run 'brew install node'?"; then brew install node; else exit 1; fi
  else
    say "Node.js 22 or newer was not found. I have not installed anything."
    say "Install Node.js 22 or newer from https://nodejs.org/en/download, then run this installer again."
    exit 1
  fi
}
say "Checking for Node.js 22 or newer..."
if ! node_supported; then install_node_if_approved; fi
if ! node_supported; then
  say "Node.js is still missing or older than version 22. Please check https://nodejs.org/en/download and try again."
  exit 1
fi
say "Node.js is ready: $(node --version)."
if ! command -v npm >/dev/null 2>&1; then
  say "npm was not found. Install a Node.js package that includes npm from https://nodejs.org/en/download, then try again."
  exit 1
fi
say "npm is ready: $(npm --version)."
say "Git is optional for this archive-based install."
say "OASIS will be installed for your user in: $OASIS_PREFIX"
say "The installer uses the fixed release $OASIS_VERSION; it does not download the moving main branch."
if ask_yes_no "May I install OASIS $OASIS_VERSION in that folder using npm?"; then
  npm install --global --prefix "$OASIS_PREFIX" "$OASIS_ARCHIVE"
else
  exit 1
fi
if [ ! -x "$OASIS_BIN" ]; then
  say "The install finished, but the OASIS command was not found at $OASIS_BIN."
  say "Check the npm error above. No administrator command was run."
  exit 1
fi
say "Checking the installed OASIS version..."
"$OASIS_BIN" --version
if [ "$SKIP_SETUP" -eq 0 ]; then
  if ! "$OASIS_BIN" doctor; then
    say "The environment check reported a problem. Read the notes above before continuing."
  fi
  say "Opening first-run model setup..."
  "$OASIS_BIN" setup
else
  say "First-run setup was skipped because --skip-setup was supplied."
  "$OASIS_BIN" doctor
fi
case ":$PATH:" in
  *":$OASIS_PREFIX/bin:"*) ;;
  *)
    shell_name=$(basename "${SHELL:-sh}")
    case "$shell_name" in
      zsh) shell_file="$HOME/.zprofile" ;;
      bash) if [ -f "$HOME/.bash_profile" ]; then shell_file="$HOME/.bash_profile"; else shell_file="$HOME/.bashrc"; fi ;;
      *) shell_file="$HOME/.profile" ;;
    esac
    say "The OASIS command folder is not on your permanent PATH yet."
    if ask_yes_no "May I add $OASIS_PREFIX/bin to $shell_file for future terminals?"; then
      touch "$shell_file"
      if ! grep -F "$OASIS_PREFIX/bin" "$shell_file" >/dev/null 2>&1; then
        printf '\n# Added by the OASIS installer\nexport PATH="%s/bin:$PATH"\n' "$OASIS_PREFIX" >> "$shell_file"
      fi
      say "I added the user-only PATH entry. Open a new terminal to use 'oasis' by name."
    else
      say "For this terminal only, run: export PATH=\"$OASIS_PREFIX/bin:\$PATH\""
      say "OASIS was installed; no shell startup file was changed."
    fi
    ;;
esac
say "OASIS installation steps are complete."
