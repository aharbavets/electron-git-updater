#!/usr/bin/env bash
#
# Standalone / reference copy of the update routine. At runtime the main process
# writes an equivalent script to a temp file and runs it detached (so it works
# from inside app.asar); keep the two in sync if you edit either.
#
# Usage: update-and-restart.sh <repo_path> [<parent_pid>]
#   <repo_path>   the source git checkout to update
#   <parent_pid>  optional PID to wait on before rebuilding (the running app)

set -euo pipefail

REPO="${1:?repo path required}"
PARENT_PID="${2:-0}"
cd "$REPO"

# Platform differences, matching buildUpdateScript() in main.js.
#
# On Windows this runs under Git Bash, where `kill -0` cannot see native
# Windows processes — MSYS process ids are its own, so the wait would end
# immediately and packaging would race the still-running app. The doubled
# slashes stop MSYS rewriting //FI into a path before tasklist sees it.
case "$(uname -s)" in
  Darwin)
    app_running() { kill -0 "$PARENT_PID" 2>/dev/null; }
    app_bundle() { ls -dt out/*/*.app 2>/dev/null | head -n1 || true; }
    reopen() { open "$1"; }
    ;;
  MINGW*|MSYS*|CYGWIN*)
    app_running() { tasklist //FI "PID eq $PARENT_PID" //NH 2>/dev/null | grep -q "$PARENT_PID"; }
    app_bundle() { ls -dt out/*/*.exe 2>/dev/null | head -n1 || true; }
    reopen() { MSYS_NO_PATHCONV=1 cmd.exe /c start "" "$(cygpath -w "$1")"; }
    ;;
  *)
    app_running() { kill -0 "$PARENT_PID" 2>/dev/null; }
    app_bundle() { ls -dt out/*/* 2>/dev/null | while read -r f; do [ -f "$f" ] && [ -x "$f" ] && echo "$f" && break; done; }
    reopen() { ( nohup "$1" >/dev/null 2>&1 & ); }
    ;;
esac

# Wait (up to ~30s) for the calling app to fully quit before touching out/.
if [ "$PARENT_PID" != "0" ]; then
  for _ in $(seq 1 60); do
    app_running || break
    sleep 0.5
  done
fi

BEFORE="$(git rev-parse HEAD)"
git pull --ff-only

# Reinstall dependencies only if package.json / lockfile actually changed.
if ! git diff --quiet "$BEFORE" HEAD -- package-lock.json package.json 2>/dev/null; then
  npm ci
fi

npm run package

# Relaunch the freshly built app.
APP="$(app_bundle)"
if [ -n "${APP:-}" ]; then
  reopen "$APP"
fi
