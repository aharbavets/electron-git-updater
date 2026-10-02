#!/usr/bin/env bash
#
# Check the platform-specific halves of the updater without needing the
# platforms. Covers the two things that used to be wrong off macOS: the shell
# the script is launched with, and whether a launch that fails says so.
#
# Usage: verify-platform-launch.sh [path-to-electron-git-updater]
#   Exits 0 when every check passes, 1 otherwise.
#
# What it cannot do: run the Windows script on Windows. It proves the generated
# bash parses and that the launch path reports failure, not that tasklist and
# cmd /c start behave as expected on a real machine.

set -euo pipefail
PKG="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LAB="$(mktemp -d)"; trap 'rm -rf "$LAB"' EXIT

# electron is not loadable in a plain node process, and none of this touches it.
mkdir -p "$LAB/node_modules/electron"
echo '{"name":"electron","version":"0.0.0","main":"index.js"}' > "$LAB/node_modules/electron/package.json"
cat > "$LAB/node_modules/electron/index.js" <<'STUB'
const handlers = {};
module.exports = {
  app: { getName: () => 'Demo', quit() {} },
  ipcMain: {
    removeHandler(channel) { delete handlers[channel]; },
    handle(channel, fn) { handlers[channel] = fn; },
    __handlers: handlers,
  },
};
STUB
cp -R "$PKG" "$LAB/node_modules/electron-git-updater"
rm -rf "$LAB/node_modules/electron-git-updater/.git" "$LAB/node_modules/electron-git-updater/node_modules"
cd "$LAB"

fail=0
ok()   { echo "PASS  $1"; }
bad()  { echo "FAIL  $1"; fail=1; }

# 1. The generated script must be valid bash for every platform. A quoting slip
#    in a platform branch is otherwise only found by running it there.
node -e '
const { buildUpdateScript } = require("electron-git-updater/main");
const fs = require("fs");
for (const platform of ["darwin", "win32", "linux"]) {
  const repoPath = platform === "win32" ? "C:\\Users\\me\\My Apps\\proj" : "/home/me/proj";
  fs.writeFileSync(`${platform}.sh`, buildUpdateScript({ repoPath, parentPid: 4321, appName: "Demo", platform }));
}
'
for platform in darwin win32 linux; do
  if bash -n "$platform.sh"; then ok "$platform: generated script is valid bash"; else bad "$platform: generated script has a syntax error"; fi
done

# 2. A Windows repo path must reach the script in a form bash can cd into.
#    Backslashes survive single quotes as literals, so they have to go.
if grep -q "REPO='C:/Users/me/My Apps/proj'" win32.sh
  then ok "win32: repo path converted to forward slashes"
  else bad "win32: repo path would not be usable by bash"; fi

# 3. Each platform must get its own liveness check, bundle glob and relaunch.
grep -q 'app_running() { kill -0'                 darwin.sh && ok "darwin: waits with kill -0"        || bad "darwin: wrong liveness check"
grep -q 'app_running() { tasklist'                win32.sh  && ok "win32: waits with tasklist"        || bad "win32: kill -0 cannot see Windows PIDs"
grep -q 'app_bundle() { ls -dt out/\*/\*\.app'    darwin.sh && ok "darwin: looks for a .app"          || bad "darwin: wrong bundle glob"
grep -q 'app_bundle() { ls -dt out/\*/\*\.exe'    win32.sh  && ok "win32: looks for an .exe"          || bad "win32: wrong bundle glob"
grep -q 'reopen() { open'                         darwin.sh && ok "darwin: relaunches with open"      || bad "darwin: wrong relaunch"
grep -q 'cmd.exe /c start'                        win32.sh  && ok "win32: relaunches detached"        || bad "win32: wrong relaunch"

# 4. Nothing may reach for /bin/bash on Windows — it exists only inside MSYS,
#    so a native Windows process gets ENOENT from it.
if node -e '
const { resolveBashPath } = require("electron-git-updater/main");
Object.defineProperty(process, "platform", { value: "win32", configurable: true });
const p = resolveBashPath();
if (p === "/bin/bash") { console.error("resolved /bin/bash on Windows"); process.exit(1); }
'; then ok "win32: never resolves /bin/bash"; else bad "win32: resolved /bin/bash"; fi

# 5. The regression this was written for, exercised through the public
#    contract rather than an internal: apply() must report a launch that could
#    not start, instead of resolving { started: true } and letting the caller
#    quit the app into silence.
if node -e '
const fs = require("fs");
const { ipcMain } = require("electron");
const { initGitUpdater, IPC_APPLY } = require("electron-git-updater/main");

Object.defineProperty(process, "platform", { value: "win32", configurable: true });
process.env.GIT_INSTALL_ROOT = "/nonexistent-git";
// Pretend Git Bash is installed so the launch is attempted. cmd.exe is absent
// on a non-Windows host, so spawning it reproduces exactly the Windows ENOENT
// that used to arrive after apply() had already reported success.
const realExists = fs.existsSync;
fs.existsSync = (p) => (String(p).endsWith("bash.exe") ? true : realExists(p));

initGitUpdater({ window: null, checkOnStart: false, intervalMs: 0, onError: () => {} });
ipcMain.__handlers[IPC_APPLY]().then((result) => {
  if (result.started !== false || !result.error) {
    console.error("apply() reported", JSON.stringify(result));
    process.exit(1);
  }
  process.exit(0);
}, (e) => { console.error("apply() threw", e.message); process.exit(1); });
'; then ok "apply() reports a failed launch instead of quitting silently"; else bad "apply() hid a failed launch"; fi

echo
[ "$fail" = 0 ] && echo "ALL PASSED" || echo "FAILURES"
exit "$fail"
