// Main-process side of electron-git-updater.
//
// Responsibilities:
//   1. Locate the source git checkout the packaged app was built from.
//   2. Periodically report whether the running *build* is behind the source.
//   3. On request, run the update in a visible Terminal window, then quit so
//      the script can repackage over out/ and relaunch the new build.
//
// No UI lives here on purpose — every app draws its own button or badge from
// the status object. See README.md.

const { app, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const IPC_CHECK = 'git-updater:check';
const IPC_APPLY = 'git-updater:apply';
const EVT_STATUS = 'git-updater:status';

// Run a git command in `cwd`, resolving with trimmed stdout.
//
// GIT_TERMINAL_PROMPT=0 matters: without it a remote that wants credentials
// blocks on a prompt nobody can see, and the check hangs forever rather than
// failing.
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(String(stdout).trim());
        }
      }
    );
  });
}

// Walk up from `start` until a directory containing `.git` is found.
function findGitRoot(start) {
  let dir = start;
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch (_) {
    /* start may not exist; fall through */
  }
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Resolve the source checkout. When packaged, app.getAppPath() points inside
// out/.../App.app, whose ancestor is the project root that holds .git.
function resolveRepoPath(explicit) {
  if (explicit) return explicit;
  const candidates = [];
  try { candidates.push(app.getAppPath()); } catch (_) { /* not ready */ }
  candidates.push(process.execPath, process.cwd());
  for (const c of candidates) {
    const root = findGitRoot(c);
    if (root) return root;
  }
  return process.cwd();
}

// npm lifecycle scripts that execute arbitrary code on install — the exact
// vector a supply-chain worm uses to run a payload.
const LIFECYCLE_HOOKS = [
  'preinstall', 'install', 'postinstall',
  'preuninstall', 'uninstall', 'postuninstall',
  'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack',
];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// A dependency pointing somewhere other than the npm registry (git, url,
// tarball, local path) — bypasses registry review, another classic vector.
const NON_REGISTRY = /(:\/\/)|^git[+:]|^github:|^file:|^https?:|\.(tar|gz|tgz)$/i;

async function readPackageJsonAtRef(repoPath, ref) {
  try {
    return JSON.parse(await git(['show', `${ref}:package.json`], repoPath));
  } catch (_) {
    return null;
  }
}

// Compare the local package.json against the upstream one and flag changes that
// could introduce malicious code on the next `npm install`: added/changed
// lifecycle scripts, brand-new dependencies, or deps switched to a non-registry
// source. Returns { risky, reasons }.
async function inspectIncomingRisk(repoPath) {
  const before = await readPackageJsonAtRef(repoPath, 'HEAD');
  const after = await readPackageJsonAtRef(repoPath, '@{upstream}');
  if (!before || !after) return { risky: false, reasons: [] };

  const reasons = [];
  const beforeScripts = before.scripts || {};
  const afterScripts = after.scripts || {};
  for (const hook of LIFECYCLE_HOOKS) {
    if (afterScripts[hook] && afterScripts[hook] !== beforeScripts[hook]) {
      reasons.push(`install hook ${beforeScripts[hook] ? 'changed' : 'added'}: "${hook}"`);
    }
  }

  for (const field of DEP_FIELDS) {
    const beforeDeps = before[field] || {};
    const afterDeps = after[field] || {};
    for (const name of Object.keys(afterDeps)) {
      if (!(name in beforeDeps)) {
        reasons.push(`new ${field}: ${name}`);
      } else if (afterDeps[name] !== beforeDeps[name] && NON_REGISTRY.test(String(afterDeps[name]))) {
        reasons.push(`${field} now from a non-registry source: ${name} (${afterDeps[name]})`);
      }
    }
  }

  return { risky: reasons.length > 0, reasons };
}

// Newest commit we could update to: the remote's tip, or local HEAD when the
// branch has no upstream.
async function latestAvailableCommit(repoPath) {
  try {
    return await git(['rev-parse', '@{upstream}'], repoPath);
  } catch (_) {
    return await git(['rev-parse', 'HEAD'], repoPath);
  }
}

async function commitExists(repoPath, commit) {
  try {
    await git(['cat-file', '-e', `${commit}^{commit}`], repoPath);
    return true;
  } catch (_) {
    return false;
  }
}

const REMOTES_PREFIX = 'refs/remotes/';

// The remote branch committed to most recently.
//
// refs/remotes also holds the symbolic refs/remotes/origin/HEAD, which mirrors
// the default branch and ties with it on date. It must be filtered by its FULL
// refname: %(refname:short) abbreviates it to plain "origin", so checking for a
// "/HEAD" suffix on the short name silently misses it — and then every branch
// looks stale, including the one you are on.
async function mostRecentlyUpdatedBranch(repoPath) {
  const out = await git(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', '--count=10', 'refs/remotes'],
    repoPath
  );
  const ref = out
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.startsWith(REMOTES_PREFIX) && !r.endsWith('/HEAD'))[0];
  return ref ? ref.slice(REMOTES_PREFIX.length) : '';
}

/**
 * Report whether the running build is behind the source.
 *
 * @param {string} repoPath
 * @param {string} [buildCommit] commit this build was made from — see
 *   electron-git-updater/webpack. Without it the check falls back to HEAD,
 *   which cannot tell "pulled but not rebuilt" from "up to date": the source
 *   moves while the running app stays on the old code, and it would report
 *   itself current while running stale.
 */
async function checkForUpdates(repoPath, buildCommit) {
  await git(['fetch', '--quiet'], repoPath);

  const branchRaw = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  // "HEAD" here means a detached checkout, not a branch called HEAD
  const branch = branchRaw === 'HEAD' ? '' : branchRaw;

  let upstream = '';
  try {
    upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoPath);
  } catch (_) {
    /* no upstream configured */
  }

  const latest = await latestAvailableCommit(repoPath);
  const builtFrom =
    buildCommit && (await commitExists(repoPath, buildCommit)) ? buildCommit : 'HEAD';
  const behind = parseInt(await git(['rev-list', '--count', `${builtFrom}..${latest}`], repoPath), 10) || 0;

  const mostRecentBranch = await mostRecentlyUpdatedBranch(repoPath);
  // Unknown (no remotes) counts as fine — only flag a branch we can actually
  // point the user at a better alternative to.
  const onMostRecentBranch = !mostRecentBranch || upstream === mostRecentBranch;

  const status = {
    available: behind > 0,
    behind,
    branch,
    upstream,
    mostRecentBranch,
    onMostRecentBranch,
    builtCommit: builtFrom === 'HEAD' ? null : buildCommit,
    knowsBuildCommit: builtFrom !== 'HEAD',
  };

  if (behind > 0) Object.assign(status, await inspectIncomingRisk(repoPath));
  return status;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The update script.
//
// Written to a temp file rather than shipped as a sibling: the package is
// bundled into app.asar (loose files there are not executable) and webpack
// rewrites __dirname. Living in /tmp has a second benefit — the pull replaces
// the repo's own files mid-run, and bash reads a script incrementally, so a
// script inside the repo could resume at a stale byte offset and execute
// garbage.
//
// Values are baked in rather than passed as arguments because `open -a
// Terminal` cannot forward arguments to the script.
function buildUpdateScript({ repoPath, parentPid, appName }) {
  return `#!/usr/bin/env bash
# Update ${appName} — generated by electron-git-updater.
# No 'set -e': each step is checked so the failing one can be named.
set -uo pipefail

REPO=${shellQuote(repoPath)}
PARENT_PID=${shellQuote(String(parentPid))}

cd "$REPO" || { echo "Cannot enter $REPO"; read -r -p "Press Enter to close… " _; exit 1; }

app_bundle() { ls -dt out/*/*.app 2>/dev/null | head -n1 || true; }

# On failure the app is deliberately NOT reopened: it would pop up over this
# window and hide the error that explains what went wrong.
die() {
  local bundle; bundle=$(app_bundle)
  echo
  echo "❌ Update failed: $1"
  echo
  echo "The app has NOT been reopened — the error above is what matters."
  [ -n "$bundle" ] && echo "Reopen the previous build with:  open '$REPO/$bundle'"
  echo
  read -r -p "Press Enter to close this window… " _ || true
  exit 1
}

step() { echo; echo "▶ $1"; echo "──────────────────────────────────────────────────────────"; }
confirm() { local a; read -r -p "$1 [y/N] " a; case "$a" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac; }

echo "Updating ${appName}"
echo "$REPO"

# Wait for the app to quit before touching out/ — packaging cannot overwrite a
# bundle that is still running on some platforms, and on macOS the running copy
# would keep the old code anyway.
if [ "$PARENT_PID" != "0" ]; then
  step "Waiting for the app to quit"
  for _ in $(seq 1 60); do kill -0 "$PARENT_PID" 2>/dev/null || break; sleep 0.5; done
  echo "Done."
fi

# A dirty tree is the most common reason this fails: git pull refuses rather
# than clobbering local edits. Say so up front instead of failing cryptically.
step "Checking for local changes"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  echo
  echo "⚠️  You have uncommitted changes; git pull will fail if any conflict."
  confirm "Continue anyway?" || die "cancelled — commit or stash your changes first"
else
  echo "Working tree is clean."
fi

BEFORE="$(git rev-parse HEAD)"

step "Pulling the latest source"
git pull --ff-only || die "git pull"

# Never install dependencies that arrived with this pull. npm install runs
# preinstall/postinstall scripts from every package, on this machine, with
# these permissions — so a commit that adds a dependency is a commit that runs
# code here, and anyone able to push to the remote can write it. The updater
# reports what changed and stops; installing is a decision for a human who has
# read the diff.
step "Checking what the new commits want to install"
if git diff --quiet "$BEFORE" HEAD -- package.json package-lock.json 2>/dev/null; then
  echo "No dependency or script changes."
else
  git --no-pager diff "$BEFORE" HEAD -- package.json
  echo
  echo "⚠️  The source is now at the new commits, but nothing was installed and"
  echo "    nothing was built. Review the diff above, then finish by hand:"
  echo
  echo "        cd '$REPO' && npm install && npm run package"
  echo
  die "incoming commits change dependencies or install scripts"
fi

step "Building the app"
npm run package || die "npm run package"

BUNDLE=$(app_bundle)
echo
echo "✅ Update complete."
if [ -n "$BUNDLE" ]; then
  echo "Reopening $BUNDLE"
  open "$BUNDLE"
else
  echo "No built app found under out/ — nothing to reopen."
  read -r -p "Press Enter to close this window… " _ || true
fi
`;
}

/**
 * Launch the update in a visible Terminal window (macOS), or detached
 * otherwise. Resolves when the launcher has started; rejects if it could not.
 */
function spawnUpdate(repoPath, appName) {
  const scriptPath = path.join(os.tmpdir(), `electron-git-updater-${process.pid}.sh`);
  fs.writeFileSync(
    scriptPath,
    buildUpdateScript({ repoPath, parentPid: process.pid, appName }),
    { mode: 0o755 }
  );

  if (process.platform !== 'darwin') {
    const child = spawn('/bin/bash', [scriptPath], { cwd: repoPath, detached: true, stdio: 'ignore' });
    child.unref();
    return Promise.resolve();
  }

  // `open -a Terminal <script>` rather than osascript: scripting Terminal sends
  // an Apple Event, which macOS blocks unless the app ships
  // NSAppleEventsUsageDescription *and* the user granted Automation
  // permission. When blocked, nothing happens at all — no window, no error.
  // Launch Services has no such gate.
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Terminal', scriptPath], (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Wire up the updater in the main process.
 *
 * @param {object} [options]
 * @param {import('electron').BrowserWindow|null} [options.window] window to push status events to
 * @param {string|null} [options.buildCommit] commit this build was made from (see ./webpack)
 * @param {string|null} [options.repoPath] explicit source checkout (auto-detected by default)
 * @param {number} [options.intervalMs] re-check interval (default 15 min; 0 disables)
 * @param {boolean} [options.checkOnStart] check shortly after launch (default true)
 * @param {(message: string, error: unknown) => void} [options.onError]
 */
function initGitUpdater(options = {}) {
  const {
    window = null,
    buildCommit = null,
    repoPath = null,
    intervalMs = 15 * 60 * 1000,
    checkOnStart = true,
    onError = (message, error) => console.error('[git-updater]', message, error),
  } = options;

  const repo = resolveRepoPath(repoPath);
  const appName = (() => { try { return app.getName(); } catch (_) { return 'the app'; } })();

  function send(status) {
    if (window && !window.isDestroyed()) window.webContents.send(EVT_STATUS, status);
  }

  async function runCheck() {
    try {
      const status = await checkForUpdates(repo, buildCommit);
      send(status);
      return status;
    } catch (error) {
      // Offline, no upstream, not a checkout — all ordinary. Report it, but
      // leave the UI in its neutral state rather than alarming anyone.
      onError('update check failed', error);
      const status = { available: false, behind: 0, error: String((error && error.message) || error) };
      send(status);
      return status;
    }
  }

  // Re-register cleanly in case init runs twice (e.g. window recreated).
  ipcMain.removeHandler(IPC_CHECK);
  ipcMain.removeHandler(IPC_APPLY);
  ipcMain.handle(IPC_CHECK, () => runCheck());
  ipcMain.handle(IPC_APPLY, async () => {
    try {
      // Always. A commit that adds a dependency or an install hook runs code
      // on this machine the moment npm install does — so the updater refuses
      // to carry it out and reports what it saw instead. This is not
      // configurable on purpose: the one time it matters, a default is not
      // something to have got wrong.
      const { risky, reasons } = await inspectIncomingRisk(repo);
      if (risky) {
        onError('update blocked: risky package.json changes', new Error(reasons.join('; ')));
        return { started: false, blocked: true, reasons };
      }

      // Awaited so a failed launch is reported instead of the app quitting into
      // silence. Quitting without a visible window was the original bug.
      await spawnUpdate(repo, appName);

      // Let the reply reach the renderer, then quit so the script can
      // repackage over out/.
      setTimeout(() => app.quit(), 600);
      return { started: true };
    } catch (error) {
      onError('update apply failed', error);
      return { started: false, error: String((error && error.message) || error) };
    }
  });

  if (checkOnStart) setTimeout(runCheck, 4000);
  const timer = intervalMs > 0 ? setInterval(runCheck, intervalMs) : null;

  return {
    check: runCheck,
    repoPath: repo,
    stop() {
      if (timer) clearInterval(timer);
      ipcMain.removeHandler(IPC_CHECK);
      ipcMain.removeHandler(IPC_APPLY);
    },
  };
}

module.exports = {
  initGitUpdater,
  checkForUpdates,
  inspectIncomingRisk,
  resolveRepoPath,
  buildUpdateScript,
  IPC_CHECK,
  IPC_APPLY,
  EVT_STATUS,
};
