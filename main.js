// Main-process side of electron-git-updater.
//
// Responsibilities:
//   1. Locate the source git checkout the packaged app was built from.
//   2. Periodically `git fetch` and report how many commits the local branch
//      is behind its upstream (an "incoming changes" / update-available signal).
//   3. On request, spawn a detached shell script that waits for this app to
//      quit, pulls + (conditionally) reinstalls + repackages, then relaunches
//      the freshly built app.
//
// The update script is written to a temp file at apply time rather than shipped
// as a sibling file, because the package is bundled into app.asar (where loose
// files are not executable) and webpack rewrites __dirname.

const { app, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const IPC_CHECK = 'git-updater:check';
const IPC_APPLY = 'git-updater:apply';
const EVT_STATUS = 'git-updater:status';

// macOS-focused: wait for the parent app to quit (so packaging can overwrite
// out/), reinstall only when dependency manifests changed, repackage, then
// reopen the newest built .app.
const UPDATE_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
REPO="\${1:?repo path required}"
PARENT_PID="\${2:-0}"
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
if [ -n "\${APP:-}" ]; then
  open "$APP"
fi
`;

// Run a git command in `cwd`, resolving with trimmed stdout.
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(String(stdout).trim());
      }
    });
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

// npm lifecycle scripts that execute arbitrary code on install/uninstall —
// the exact vector a supply-chain worm uses to run a payload.
const LIFECYCLE_HOOKS = [
  'preinstall', 'install', 'postinstall',
  'preuninstall', 'uninstall', 'postuninstall',
  'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack',
];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// A dependency value pointing somewhere other than the npm registry (git, url,
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

async function checkForUpdates(repoPath) {
  await git(['fetch', '--quiet'], repoPath);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  let upstream;
  try {
    upstream = await git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      repoPath
    );
  } catch (_) {
    return { available: false, behind: 0, branch, reason: 'no-upstream' };
  }
  const countStr = await git(['rev-list', '--count', 'HEAD..@{upstream}'], repoPath);
  const behind = parseInt(countStr, 10) || 0;
  if (behind === 0) return { available: false, behind, branch, upstream };

  // When risky, the renderer withholds one-click update and asks the user to
  // review + update manually.
  const { risky, reasons } = await inspectIncomingRisk(repoPath);
  return { available: true, behind, branch, upstream, risky, reasons };
}

// Write the update script to a temp file and spawn it fully detached so it
// survives this process quitting.
function spawnUpdate(repoPath) {
  const scriptPath = path.join(os.tmpdir(), `electron-git-updater-${process.pid}.sh`);
  fs.writeFileSync(scriptPath, UPDATE_SCRIPT, { mode: 0o755 });
  const child = spawn('/bin/bash', [scriptPath, repoPath, String(process.pid)], {
    cwd: repoPath,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Wire up the updater in the main process.
 * @param {object} [options]
 * @param {import('electron').BrowserWindow|null} [options.window] window to push status events to
 * @param {string|null} [options.repoPath] explicit source checkout path (auto-detected by default)
 * @param {number} [options.intervalMs] how often to re-check (default 30 min; 0 disables)
 * @param {boolean} [options.checkOnStart] run an initial check shortly after launch (default true)
 * @param {(message: string, error: unknown) => void} [options.onError]
 */
function initGitUpdater(options = {}) {
  const {
    window = null,
    repoPath = null,
    intervalMs = 30 * 60 * 1000,
    checkOnStart = true,
    onError = (message, error) => console.error('[git-updater]', message, error),
  } = options;

  const repo = resolveRepoPath(repoPath);

  function send(status) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(EVT_STATUS, status);
    }
  }

  async function runCheck() {
    try {
      const status = await checkForUpdates(repo);
      send(status);
      return status;
    } catch (error) {
      onError('update check failed', error);
      const status = {
        available: false,
        behind: 0,
        error: String((error && error.message) || error),
      };
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
      // Defense-in-depth: even if the renderer asks to apply, refuse to
      // auto-run an update that changes install hooks or dependencies — the
      // user must review and update manually.
      const { risky, reasons } = await inspectIncomingRisk(repo);
      if (risky) {
        onError('update blocked: risky package.json changes', new Error(reasons.join('; ')));
        return { started: false, blocked: true, reasons };
      }
      spawnUpdate(repo);
      // Give the renderer a moment to show its "updating" state, then quit so
      // the detached script can repackage over out/.
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
  IPC_CHECK,
  IPC_APPLY,
  EVT_STATUS,
};
