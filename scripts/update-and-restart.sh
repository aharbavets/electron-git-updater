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

# Wait (up to ~30s) for the calling app to fully quit before touching out/.
if [ "$PARENT_PID" != "0" ]; then
  for _ in $(seq 1 60); do
    kill -0 "$PARENT_PID" 2>/dev/null || break
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

# Relaunch the freshly built app (macOS). Best-effort on other platforms.
APP="$(ls -dt out/*/*.app 2>/dev/null | head -n1 || true)"
if [ -n "${APP:-}" ]; then
  open "$APP"
fi
