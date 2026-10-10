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

// Electron is a peer, not a dependency, and this file is also loaded from the
// command line where there is no Electron at all.
//
// ⚠️ Outside Electron, `require('electron')` does not fail — the npm package
// exports the *path to the binary*, a string. So the guard has to survive both
// "not installed" and "installed but not running inside it", which is why the
// pieces are read off the module rather than destructured.
const electron = (() => {
  try {
    return require('electron');
  } catch (_) {
    return null;
  }
})();
const app = electron && electron.app;
const ipcMain = electron && electron.ipcMain;
const { execFile, execFileSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const IPC_CHECK = 'git-updater:check';
const IPC_APPLY = 'git-updater:apply';
const EVT_STATUS = 'git-updater:status';

// Typed by hand to let an update that changes dependencies go ahead.
//
// One word, and a claim about the person rather than a permission: typing it
// asserts the diff above was read. "YES" or "y" is a reflex at a prompt; this
// is not, and it is still short enough not to invite a copy-paste.
const RISK_CONFIRMATION = 'REVIEWED';

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

// Fetch URL of the remote backing `upstream` (e.g. "origin/main" → origin), or
// '' when it cannot be determined. Used to tailor the "can't reach the remote"
// warning: suggesting HTTPS only makes sense for an SSH remote.
async function remoteUrlFor(repoPath, upstream) {
  const remote = (upstream || '').split('/')[0] || 'origin';
  try {
    return await git(['remote', 'get-url', remote], repoPath);
  } catch (_) {
    return '';
  }
}

// --- Is the updater itself out of date? --------------------------------------
//
// This library is almost always the host app's only git dependency, and a git
// dependency with a `#semver:` range goes stale without anything saying so:
// `package.json` does not change when a new tag appears, so the update script
// correctly reports "no dependency changes" while the installed copy stays
// behind. Measured 2026-10-08: a host app ran 1.0.0 for a day after 1.0.1 was
// tagged, failing on the exact bug 1.0.1 fixed, with every rebuild succeeding.
//
// 🚨 And `npm install` does not fix it. package-lock.json pins the resolved
// commit, and install honours the lock — so it reinstalls the same version and
// reports success. Only `npm update <name>` re-resolves the range.

const PACKAGE_NAME = require('./package.json').name;
const INSTALLED_VERSION = require('./package.json').version;

/** Compare dotted numeric versions; > 0 when `a` is newer than `b`. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The git URL out of an npm dependency spec such as
 * `git+ssh://git@github.com/owner/repo.git#semver:^1.0.0`.
 * Returns null for anything that is not a git spec — a registry version, say.
 */
function gitUrlFromSpec(spec) {
  if (typeof spec !== 'string') return null;
  const withoutFragment = spec.split('#')[0];
  if (/^git\+/.test(withoutFragment)) return withoutFragment.replace(/^git\+/, '');
  if (/^(git:|ssh:|https?:).*\.git$/.test(withoutFragment)) return withoutFragment;
  if (/^github:/.test(withoutFragment)) {
    return `https://github.com/${withoutFragment.replace(/^github:/, '')}.git`;
  }
  return null;
}

/**
 * The SSH equivalent of an HTTPS GitHub URL, or null.
 *
 * 🚨 This is what makes the check work at all for a private package. An npm
 * dependency is commonly declared over HTTPS, and `git ls-remote` against a
 * private repository over HTTPS has no credentials in a GUI app's environment:
 * it asks for a username, and with GIT_TERMINAL_PROMPT=0 simply fails. The
 * same repository over SSH goes through the agent and answers.
 */
function sshEquivalentOf(url) {
  const match = /^https?:\/\/github\.com\/(.+?)(\.git)?$/.exec(String(url || ''));
  return match ? `git@github.com:${match[1]}.git` : null;
}

/**
 * Every address worth trying for this package's own remote, best first.
 *
 * The host app's declared spec comes first because it is the authority on
 * where this copy actually came from — a fork installed from another remote
 * must be compared against *that* remote. The SSH rewrite follows for the
 * private-over-HTTPS case, and this package's own `repository` field last.
 */
function candidateRemoteUrls(repoPath) {
  const candidates = [];
  const add = (url) => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };

  try {
    const hostManifest = JSON.parse(
      fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')
    );
    const spec =
      (hostManifest.dependencies && hostManifest.dependencies[PACKAGE_NAME]) ||
      (hostManifest.devDependencies && hostManifest.devDependencies[PACKAGE_NAME]);
    const fromHost = gitUrlFromSpec(spec);
    add(fromHost);
    add(sshEquivalentOf(fromHost));
  } catch (_) {
    /* no host manifest, or not JSON — fall through to our own */
  }

  const own = require('./package.json').repository;
  const ownUrl = gitUrlFromSpec(typeof own === 'string' ? own : own && own.url);
  add(ownUrl);
  add(sshEquivalentOf(ownUrl));
  return candidates;
}

/** The newest `vX.Y.Z` tag on a remote, or null when none can be read. */
async function newestPublishedVersion(url) {
  const out = await git(['ls-remote', '--tags', '--refs', url]);
  let newest = null;
  for (const line of out.split('\n')) {
    const match = /refs\/tags\/v?(\d+\.\d+\.\d+)$/.exec(line.trim());
    if (!match) continue;
    if (!newest || compareVersions(match[1], newest) > 0) newest = match[1];
  }
  return newest;
}

/**
 * Whether the installed copy of this package is behind its newest tag.
 *
 * Never throws: this is a courtesy check running beside the real one, and an
 * unreachable remote must not take the update check down with it.
 *
 * @param {string} repoPath host app checkout
 * @returns {Promise<{installed: string, latest: string|null, outdated: boolean, error?: string}>}
 */
async function checkUpdaterVersion(repoPath) {
  const result = { installed: INSTALLED_VERSION, latest: null, outdated: false };
  const candidates = candidateRemoteUrls(repoPath);
  if (candidates.length === 0) {
    result.error = `no git remote known for ${PACKAGE_NAME}`;
    return result;
  }

  let lastError = '';
  for (const url of candidates) {
    try {
      const latest = await newestPublishedVersion(url);
      if (!latest) {
        lastError = `no version tags on ${url}`;
        continue;
      }
      result.latest = latest;
      result.outdated = compareVersions(latest, INSTALLED_VERSION) > 0;
      return result;
    } catch (error) {
      lastError = String(
        (error && error.stderr) || (error && error.message) || error
      ).trim();
    }
  }
  result.error = lastError;
  return result;
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
  // A failed fetch must not abort the check. The remote-tracking refs from the
  // last successful fetch can already show the build is behind, and on a GUI app
  // whose environment carries no git credentials (e.g. no ssh-agent on Windows)
  // every fetch fails — reporting from local refs beats reporting nothing.
  let fetchFailed = false;
  let fetchError = '';
  try {
    await git(['fetch', '--quiet'], repoPath);
  } catch (error) {
    fetchFailed = true;
    fetchError = String((error && error.stderr) || (error && error.message) || error).trim();
  }

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
    fetchFailed,
  };

  if (fetchFailed) {
    status.fetchError = fetchError;
    // A credential/permission failure reaching the remote — the check can't see
    // new commits. On a GUI app this is usually a missing ssh-agent.
    status.fetchAuthFailed =
      /permission denied|publickey|could not read from remote|authentication failed/i.test(fetchError);
    status.remoteIsSsh = /^(git@|ssh:\/\/)/i.test(await remoteUrlFor(repoPath, upstream));
  }

  if (behind > 0) Object.assign(status, await inspectIncomingRisk(repoPath));

  // Only when the fetch worked: a failed fetch means the network or the
  // credentials are the problem, and a second remote call would just fail
  // again and slow the check down for nothing.
  if (!fetchFailed) status.updater = await checkUpdaterVersion(repoPath);

  return status;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Per-platform pieces of the update script: how to tell whether the app has
// quit, where `npm run package` leaves the build, and how to start it again.
//
// The script is bash everywhere — on Windows it runs under the bash that ships
// with Git for Windows, which is already required for the git commands.
const SCRIPT_PARTS = {
  darwin: {
    appRunning: `kill -0 "$PARENT_PID" 2>/dev/null`,
    appBundle: `ls -dt out/*/*.app 2>/dev/null | head -n1 || true`,
    reopen: `open "$1"`,
    reopenHint: `echo "open '$REPO/$1'"`,
  },
  win32: {
    // MSYS bash cannot see native Windows processes with `kill -0`: its PIDs
    // are its own, so the check would always say "gone" and packaging would
    // race the still-running app. tasklist asks Windows directly.
    //
    // The doubled slashes are deliberate. MSYS rewrites a lone /FI into a
    // path before the program ever sees it; //FI survives as /FI.
    appRunning: `tasklist //FI "PID eq $PARENT_PID" //NH 2>/dev/null | grep -q "$PARENT_PID"`,
    appBundle: `ls -dt out/*/*.exe 2>/dev/null | head -n1 || true`,
    // `start` detaches the app from this console, so closing the window later
    // does not take the app with it. MSYS_NO_PATHCONV keeps /c as a flag.
    reopen: `MSYS_NO_PATHCONV=1 cmd.exe /c start "" "$(cygpath -w "$1")"`,
    reopenHint: `echo "start \\"\\" '$REPO/$1'"`,
  },
  linux: {
    appRunning: `kill -0 "$PARENT_PID" 2>/dev/null`,
    // No extension to match on, so take the newest executable file instead.
    appBundle: `ls -dt out/*/* 2>/dev/null | while read -r f; do [ -f "$f" ] && [ -x "$f" ] && echo "$f" && break; done`,
    // Subshell rather than a bare `&`, so the function body still ends in a
    // command the enclosing `{ …; }` can terminate.
    reopen: `( nohup "$1" >/dev/null 2>&1 & )`,
    reopenHint: `echo "'$REPO/$1'"`,
  },
};

const scriptPartsFor = (platform) => SCRIPT_PARTS[platform] || SCRIPT_PARTS.linux;

// The update script.
//
// Written to a temp file rather than shipped as a sibling: the package is
// bundled into app.asar (loose files there are not executable) and webpack
// rewrites __dirname. Living in the temp dir has a second benefit — the pull
// replaces the repo's own files mid-run, and bash reads a script incrementally,
// so a script inside the repo could resume at a stale byte offset and execute
// garbage.
//
// Values are baked in rather than passed as arguments because `open -a
// Terminal` cannot forward arguments to the script.
function buildUpdateScript({
  repoPath,
  parentPid,
  appName,
  updater,
  allowRisky = false,
  riskPhrase = RISK_CONFIRMATION,
  platform = process.platform,
}) {
  const parts = scriptPartsFor(platform);
  // Git Bash accepts C:/dir but not every backslash form, and backslashes
  // inside the single quotes below would survive as literals — so hand the
  // script a path it can actually cd into.
  const repoForShell = platform === 'win32' ? String(repoPath).replace(/\\/g, '/') : repoPath;

  return `#!/usr/bin/env bash
# Update ${appName} — generated by electron-git-updater.
# No 'set -e': each step is checked so the failing one can be named.
set -uo pipefail

REPO=${shellQuote(repoForShell)}
PARENT_PID=${shellQuote(String(parentPid))}
# Empty unless the updater itself is behind its newest tag.
UPDATER_NAME=${shellQuote(PACKAGE_NAME)}
# Empty unless the host allows a risky update to be confirmed by hand.
ALLOW_RISKY=${shellQuote(allowRisky ? '1' : '')}
RISK_PHRASE=${shellQuote(riskPhrase)}
UPDATER_INSTALLED=${shellQuote(updater && updater.outdated ? String(updater.installed) : '')}
UPDATER_LATEST=${shellQuote(updater && updater.outdated ? String(updater.latest) : '')}
# Pre-quoted in JavaScript rather than assembled in the script: the command
# contains both kinds of quote, and nesting them inside an echo is what stops
# the generated script parsing — which breaks every update, not just this
# message, because bash parses the whole file before running any of it.
UPDATER_VERIFY=${shellQuote(
  `node -p "require('./node_modules/${PACKAGE_NAME}/package.json').version"`
)}

cd "$REPO" || { echo "Cannot enter $REPO"; read -r -p "Press Enter to close… " _; exit 1; }

app_running() { ${parts.appRunning}; }
app_bundle() { ${parts.appBundle}; }
reopen() { ${parts.reopen}; }
reopen_hint() { ${parts.reopenHint}; }

# On failure the app is deliberately NOT reopened: it would pop up over this
# window and hide the error that explains what went wrong.
die() {
  local bundle; bundle=$(app_bundle)
  echo
  echo "❌ Update failed: $1"
  echo
  echo "The app has NOT been reopened — the error above is what matters."
  [ -n "$bundle" ] && echo "Reopen the previous build with:  $(reopen_hint "$bundle")"
  echo
  read -r -p "Press Enter to close this window… " _ || true
  exit 1
}

step() { echo; echo "▶ $1"; echo "──────────────────────────────────────────────────────────"; }
confirm() { local a; read -r -p "$1 [y/N] " a; case "$a" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac; }

echo "Updating ${appName}"
echo "$REPO"

# Wait for the app to quit before touching out/ — packaging cannot overwrite a
# build that is still running on some platforms, and on macOS the running copy
# would keep the old code anyway.
if [ "$PARENT_PID" != "0" ]; then
  step "Waiting for the app to quit"
  for _ in $(seq 1 60); do app_running || break; sleep 0.5; done
  echo "Done."
fi

# A dirty tree is the most common reason this fails: the merge refuses rather
# than clobbering local edits. Say so up front instead of failing cryptically.
step "Checking for local changes"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  echo
  echo "⚠️  You have uncommitted changes; the update will fail if any conflict."
  confirm "Continue anyway?" || die "cancelled — commit or stash your changes first"
else
  echo "Working tree is clean."
fi

BEFORE="$(git rev-parse HEAD)"

step "Pulling the latest source"
# Deliberately not "git pull".
#
# git pull decides what to merge by reading .git/FETCH_HEAD, a scratch file
# that git rewrites on every fetch and does NOT lock between processes. A
# checkout shared with an IDE, another agent, or a second copy of this script
# can have two fetches land in that file at once; the same branch is then
# listed twice and every later pull dies with "Cannot fast-forward to multiple
# branches" — a fault in a temporary file that reads as a fault in the
# repository, and that no amount of inspecting git config explains.
#
# --ff-only does not help: it constrains the result of the merge, while the
# damage is in the input. Fetching and then merging the branch's configured
# upstream never opens FETCH_HEAD at all.
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -z "$UPSTREAM" ]; then
  die "this branch has no upstream; set one with: git branch --set-upstream-to=origin/$(git rev-parse --abbrev-ref HEAD)"
fi
git fetch || die "git fetch"
git merge --ff-only "$UPSTREAM" || die "git merge --ff-only $UPSTREAM"

# Never install dependencies that arrived with this pull. npm install runs
# preinstall/postinstall scripts from every package, on this machine, with
# these permissions — so a commit that adds a dependency is a commit that runs
# code here, and anyone able to push to the remote can write it. The updater
# reports what changed and stops; installing is a decision for a human who has
# read the diff.
step "Checking what the new commits want to install"
# Compared against the WORKING TREE, not against HEAD.
#
# npm install reads the working tree, so that is what has to be reviewed. With
# HEAD in the comparison the two disagreed, and the gap was reachable: an
# upstream commit touching only package-lock.json fires this step, the diff of
# package.json prints empty because nothing changed in the commits, and an
# uncommitted postinstall sitting in the working tree is then executed by the
# install — never having been shown to the person who confirmed it.
if git diff --quiet "$BEFORE" -- package.json package-lock.json 2>/dev/null; then
  echo "No dependency or script changes."
  # A git dependency can still be stale here: its range has not changed, so
  # this step is right to say nothing changed, and the installed copy is
  # behind all the same.
  if [ -n "$UPDATER_LATEST" ]; then
    echo
    echo "⚠️  $UPDATER_NAME $UPDATER_INSTALLED is installed, but $UPDATER_LATEST is released."
    echo "    'npm install' will NOT move it: package-lock.json pins the resolved"
    echo "    commit and install honours the lock, so it reports success and"
    echo "    changes nothing. Afterwards, check what landed:"
    echo
    echo "        cd '$REPO' && npm update $UPDATER_NAME && npm run package"
    echo "        $UPDATER_VERIFY"
    echo
  fi
else
  # Both files, because either can fire this step. A lockfile-only change used
  # to print nothing at all and then ask the person to "read the diff above",
  # which is the same fault as reviewing the wrong thing: being asked to
  # confirm something you were never shown.
  git --no-pager diff --stat "$BEFORE" -- package.json package-lock.json
  echo
  if git diff --quiet "$BEFORE" -- package.json 2>/dev/null; then
    echo "package.json itself is unchanged — only the lockfile moved, so the"
    echo "resolved versions changed without the declared ranges changing."
    echo "Inspect it with:"
    echo
    echo "        cd '$REPO' && git diff $BEFORE -- package-lock.json"
  else
    git --no-pager diff "$BEFORE" -- package.json
  fi
  echo
  echo "⚠️  These commits change dependencies or install scripts."
  echo "    npm install runs preinstall/postinstall from every package in the"
  echo "    tree, with your permissions — so this is running code, not"
  echo "    downloading it. Read the diff above before deciding."
  echo
  # Only when the host opted in, and only with a terminal to type into: a
  # prompt nobody can answer would hang the update instead of failing it.
  if [ -n "$ALLOW_RISKY" ] && [ -t 0 ]; then
    printf 'Type %s to install and build anyway, anything else to stop: ' "$RISK_PHRASE"
    read -r REPLY_RISK
    if [ "$REPLY_RISK" != "$RISK_PHRASE" ]; then
      die "not confirmed — nothing was installed"
    fi
    step "Installing dependencies"
    npm install || die "npm install"
  else
    echo "    Nothing was installed and nothing was built. Finish by hand:"
    echo
    echo "        cd '$REPO' && npm install && npm run package"
    echo
    die "incoming commits change dependencies or install scripts"
  fi
fi

step "Building the app"
npm run package || die "npm run package"

BUNDLE=$(app_bundle)
echo
echo "✅ Update complete."
if [ -n "$BUNDLE" ]; then
  echo "Reopening $BUNDLE"
  reopen "$BUNDLE"
else
  echo "No built app found under out/ — nothing to reopen."
  read -r -p "Press Enter to close this window… " _ || true
fi
`;
}

// Where Git for Windows puts bash, relative to a git it has put on PATH:
// git.exe lives in cmd\ (or mingw64\bin\), bash.exe in bin\.
const WINDOWS_BASH_FROM_GIT = [
  ['..', 'bin', 'bash.exe'],
  ['..', '..', 'bin', 'bash.exe'],
];

/**
 * Absolute path to a bash that can run the update script, or null when there
 * is none.
 *
 * On Windows this is Git Bash. `/bin/bash` must not be used there: that path
 * only exists inside the MSYS environment, so a native Windows process gets
 * ENOENT from it even with Git for Windows installed — which is exactly the
 * failure this looks for. Git is already a hard requirement of this package,
 * so its bash is the one shell that can be relied on being present.
 */
function resolveBashPath() {
  if (process.platform !== 'win32') return '/bin/bash';

  const candidates = [];
  const push = (p) => { if (p) candidates.push(p); };

  if (process.env.GIT_INSTALL_ROOT) {
    push(path.join(process.env.GIT_INSTALL_ROOT, 'bin', 'bash.exe'));
  }

  // Derive it from whichever git is actually on PATH, so a non-default install
  // location is found without having to guess it.
  try {
    const gitPath = String(execFileSync('where', ['git.exe'], { encoding: 'utf8' }))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (gitPath) {
      for (const rel of WINDOWS_BASH_FROM_GIT) {
        push(path.resolve(path.dirname(gitPath), ...rel));
      }
    }
  } catch (_) {
    /* git not on PATH; fall through to the standard locations */
  }

  for (const root of [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ]) {
    if (root) push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* unreadable path; try the next */
    }
  }
  return null;
}

/**
 * Launch the update in a visible terminal window. Resolves once the launcher
 * has actually started; rejects when it could not.
 *
 * Both halves of that matter. `spawn` reports a missing executable on an
 * asynchronous 'error' event, which arrives *after* the call returns — so
 * resolving when spawn returns reported success, the app quit 600 ms later,
 * and nothing updated. The caller could not tell that from a normal update.
 */
function spawnUpdate(repoPath, appName, updater, risk = {}) {
  const scriptPath = path.join(os.tmpdir(), `electron-git-updater-${process.pid}.sh`);
  fs.writeFileSync(
    scriptPath,
    buildUpdateScript({
      repoPath,
      parentPid: process.pid,
      appName,
      updater,
      allowRisky: risk.allowRisky,
      riskPhrase: risk.riskPhrase,
    }),
    { mode: 0o755 }
  );

  // `open -a Terminal <script>` rather than osascript: scripting Terminal sends
  // an Apple Event, which macOS blocks unless the app ships
  // NSAppleEventsUsageDescription *and* the user granted Automation
  // permission. When blocked, nothing happens at all — no window, no error.
  // Launch Services has no such gate.
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('open', ['-a', 'Terminal', scriptPath], (err) => (err ? reject(err) : resolve()));
    });
  }

  const bash = resolveBashPath();
  if (!bash) {
    return Promise.reject(
      new Error(
        'No bash found to run the update. Install Git for Windows (which provides Git Bash), ' +
          'or update manually with: git pull && npm install && npm run package'
      )
    );
  }

  // On Windows the script is launched through `cmd /c start`, which gives it a
  // real console window — the same reason macOS uses Terminal. A plain detached
  // spawn with stdio 'ignore' would run it blind, and the script asks questions
  // and reports failures that nobody would ever see.
  //
  // windowsVerbatimArguments because `start` has its own quoting rules that
  // Node's escaping does not produce: the empty "" is start's window-title
  // argument, without which it treats a quoted path as the title.
  const [command, args, extraOptions] =
    process.platform === 'win32'
      ? ['cmd.exe', [`/c start "" "${bash}" "${scriptPath}"`], { windowsVerbatimArguments: true }]
      : [bash, [scriptPath], {}];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoPath,
      detached: true,
      stdio: 'ignore',
      ...extraOptions,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
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
    // Off by default: this is the supply-chain gate, and a security default is
    // not something to loosen on a library's say-so. Turning it on does not
    // remove the gate — it moves the decision to a person standing in front of
    // the diff in a terminal, who has to type the phrase to continue.
    allowRiskyUpdates = false,
    riskPhrase = RISK_CONFIRMATION,
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
      // A commit that adds a dependency or an install hook runs code on this
      // machine the moment npm install does, so an unattended update must not
      // carry it out.
      //
      // Who gets to decide is the only configurable part. By default the
      // updater refuses here and reports what it saw. With allowRiskyUpdates
      // the refusal moves into the script, where a person can read the diff
      // and type the phrase — which is a stronger consent than a button in the
      // app, not a weaker one, because the diff is on screen while they decide.
      const { risky, reasons } = await inspectIncomingRisk(repo);
      if (risky && !allowRiskyUpdates) {
        onError('update blocked: risky package.json changes', new Error(reasons.join('; ')));
        return { started: false, blocked: true, reasons };
      }

      // Awaited so a failed launch is reported instead of the app quitting into
      // silence. Quitting without a visible window was the original bug.
      // Checked here rather than reused from the last status: the update is
      // about to run, so this is the moment the answer has to be current.
      await spawnUpdate(repo, appName, await checkUpdaterVersion(repo), {
        allowRisky: allowRiskyUpdates,
        riskPhrase,
      });

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
  resolveBashPath,
  checkForUpdates,
  checkUpdaterVersion,
  inspectIncomingRisk,
  resolveRepoPath,
  buildUpdateScript,
  RISK_CONFIRMATION,
  IPC_CHECK,
  IPC_APPLY,
  EVT_STATUS,
};
