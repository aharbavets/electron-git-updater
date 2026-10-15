# electron-git-updater

Auto-update for Electron apps that are **run from their own source checkout** — the pattern where the app lives in a git repo, is packaged with its `package` script, and is launched from `out/`. It notices when the running build is behind the source, and on request pulls, reinstalls, rebuilds and relaunches in a **visible Terminal window**.

It ships **no UI**. The main process reports a status object; your app draws whatever button, badge or banner suits it, because that part is different in every app.

## Install

```bash
npm i git+https://github.com/aharbavets/electron-git-updater.git#main
```

Full setup instructions, including Vite/esbuild builds, every option, a verification checklist and troubleshooting, are in [docs/Integration-guide.md](docs/Integration-guide.md).
The mechanics and the reasoning behind them are in [docs/How-it-works.md](docs/How-it-works.md).

## Wire it up

The short version — four places in your app. The long version is the [integration guide](docs/Integration-guide.md).

**Build config** — bake in the commit being built. This is what makes staleness detectable; see _Why the build commit matters_ below.

```js
// webpack.main.config.js
const { buildCommitDefinePlugin } = require("electron-git-updater/webpack");

module.exports = { plugins: [buildCommitDefinePlugin()] };
```

**Main process**

```ts
import { initGitUpdater } from "electron-git-updater/main";

declare const BUILD_COMMIT: string; // injected by the plugin above

initGitUpdater({ window: mainWindow, buildCommit: BUILD_COMMIT });
```

**Preload**

```ts
import { exposeGitUpdater } from "electron-git-updater/preload";

exposeGitUpdater(); // window.gitUpdater
```

**Renderer** — your UI, driven by the status object:

```tsx
const [status, setStatus] = useState<UpdateStatus | null>(null)

useEffect(() => window.gitUpdater?.onStatus(setStatus), [])

<button
    className={status?.available ? "btn btn-success" : "btn btn-outline-primary"}
    onClick={() => window.gitUpdater?.apply()}
>
    {status?.available ? "Update available" : "Update"}
</button>

{status && !status.onMostRecentBranch && (
    <span className="badge text-bg-danger">Not on a recently updated branch</span>
)}
```

`apply()` opens a Terminal and quits the app; the script relaunches it.

## The status object

| Field                                     | Meaning                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `available` / `behind`                    | whether, and how far, the running **build** is behind the newest available commit                                 |
| `branch` / `upstream`                     | current branch (`""` when detached) and what it tracks                                                            |
| `mostRecentBranch` / `onMostRecentBranch` | the most recently committed remote branch, and whether you're on it — catches "I'm on a stale feature branch"     |
| `risky` / `reasons`                       | incoming commits change dependencies or install hooks                                                             |
| `riskConfirmable`                         | whether a risky update can still go ahead from the app, because the update window will ask for the phrase          |
| `knowsBuildCommit`                        | false when no `buildCommit` was passed, so staleness was measured from `HEAD` and a stale build can't be detected |
| `error`                                   | the check couldn't run — offline, no upstream, not a checkout                                                     |
| `updater`                                 | whether this library itself is behind its newest tag — see below. Absent when the fetch failed                   |

A failed check is ordinary. Leave the UI neutral rather than alarming anyone.

## Why the build commit matters

Comparing `HEAD` with the remote is the obvious approach and it is **wrong**. Pull the source without rebuilding and `HEAD` moves while the running app keeps the old code — so the app reports itself up to date while running stale, and the update button appears to do nothing.

So the comparison is _the commit the running binary was built from_ versus the newest available. The webpack plugin bakes the former in at build time. Without it the package falls back to `HEAD` and sets `knowsBuildCommit: false`.

Vite, esbuild and no-bundler recipes: [integration guide, step 1](docs/Integration-guide.md#step-1--bake-the-build-commit-into-the-bundle).

## Why a Terminal window

The update takes minutes and can fail — a dirty tree, a conflicting pull, a broken build. Run silently, that looks exactly like the app crashing on click. The Terminal shows each step, and on failure it **keeps the window open and does not reopen the app**, so the error isn't hidden behind a window popping up over it.

macOS uses `open -a Terminal`, not `osascript`. Scripting Terminal sends an Apple Event, which macOS blocks unless the app ships `NSAppleEventsUsageDescription` _and_ the user has granted Automation permission — and when blocked, **nothing happens at all**: no window, no error. Launch Services has no such gate.

Windows gets the same treatment through `cmd /c start`, which gives the script its own console window; the shell is the bash that ships with Git for Windows, since git is already required. `/bin/bash` is not used there — that path exists only inside MSYS, so a native Windows process gets `ENOENT` from it even when Git Bash is installed. Linux still runs detached in the background.

## Supply-chain gate

Installing a dependency can run code on your machine, so a commit that adds one is a commit that runs code here — and anyone who can push to the remote can write it.

⚠️ **How exposed that is depends on the package manager, and the answer changed recently.** Measured 2026-10-10:

| manager | runs a dependency's install scripts | since |
| --- | --- | --- |
| npm 11 and earlier | **yes** | — |
| npm 12 | no, until approved | 12.0.0 (2026-07-08) |
| yarn classic | **yes** | — |
| yarn berry 4.14+ | no, for third-party | 4.14.0 |
| pnpm 10+ | no, until approved | 10.0.0 |
| bun | no, beyond its own allowlist | 0.1.7 |

**The gate is worth having under all of them**, because two things hold whatever the manager does: the project's **own** install scripts always run, and a new dependency is new code the app will load and execute at runtime anyway. The script words its warning to match the manager it detected rather than claiming the worst case everywhere.

The updater therefore inspects what the update would install — incoming commits **and** any uncommitted changes to `package.json`, since `npm install` reads the working tree — for:

- added or changed npm lifecycle hooks,
- brand-new dependencies,
- dependencies switched to a non-registry source (git, url, tarball, local path).

**When any of those are found, the update does not run unattended.** It is reported in `status.risky` / `status.reasons` so your UI can flag it, and by default `apply()` returns `{ started: false, blocked: true, reasons }` without touching anything.

**What is configurable is who decides, not whether anyone does.** With `allowRiskyUpdates: true` the refusal moves out of the app and into the update script: it prints the `package.json` diff, explains that `npm install` runs code rather than downloading it, and asks for a phrase to be typed in full.

```
Type REVIEWED to install and build anyway, anything else to stop:
```

That is a **stronger** consent than the button in the app, not a weaker one — the diff is on screen while the decision is made, and nothing but an exact match continues. A different word in either case, an empty line, or no terminal to type into all stop the update with nothing installed.

The default stays `false`. Loosening a supply-chain default on a library's say-so is not something to do quietly, and the one time it matters is the time it must not have been wrong already.

## The updater can go stale without saying so

The gate above means a released fix **does not arrive by updating the host app**. The source is pulled, the app is rebuilt, and the copy of this library under `node_modules/` is whatever it was.

That is easy to miss, because nothing looks wrong. A new tag does not change the host's `package.json` — the declared `#semver:` range already covers it — so the update script correctly reports "no dependency or script changes" while the installed copy stays behind. Measured 2026-10-08: a host app ran `1.0.0` for a day after `1.0.1` was tagged, failing on the exact bug `1.0.1` fixes, with every rebuild succeeding.

So the check also looks at this library's own remote and reports `status.updater`:

```js
{ installed: "1.0.0", latest: "1.0.1", outdated: true }
```

It never rejects. An unreachable remote, a repository with no tags, or no URL to try comes back as `error` and `latest: null` — this is a courtesy running beside the real check, and it must not take that check down. It is skipped entirely when the `git fetch` failed, since the network or the credentials are already the problem.

🚨 **`npm install` does not fix a stale git dependency.** `package-lock.json` pins the resolved commit and install honours the lock, so it reinstalls the same version and reports success. Only `npm update` re-resolves the range:

```bash
npm update electron-git-updater
node -p "require('./node_modules/electron-git-updater/package.json').version"
```

The second line is not optional — the first reports success either way. When `outdated` is true the generated update script prints both, so the person in front of the Terminal is told rather than left to notice.

⚠️ **The remote is tried at more than one address.** The host's declared dependency spec comes first, since that is the authority on where this copy came from. For a **private** package declared over HTTPS, `git ls-remote` has no credentials in a GUI app's environment and fails outright, so the HTTPS GitHub URL is also tried in its SSH form, and this package's own `repository` field last.

## Options

```ts
initGitUpdater({
  window, // where to push status events
  buildCommit, // from ./webpack — see above
  repoPath, // default: walk up from the app bundle to the .git root
  intervalMs: 15 * 60_000, // re-check interval; 0 disables
  checkOnStart: true,
  allowRiskyUpdates: false, // let risky changes be confirmed by typing a phrase
  riskPhrase: "REVIEWED", // what to type when they are
  onError,
});
```

## Package managers

npm, pnpm, yarn and bun. The one in use is detected from `packageManager` in `package.json` first — the corepack field, which says what the project *means* — then from whichever lockfile is present, then npm as the fallback.

Everything the script does follows from that: the install and build commands, the lockfile it watches for changes, and how it words the warning above. Nothing needs configuring; `buildUpdateScript({ packageManager })` overrides the detection if you need it to.

**Deno is not supported, and not for want of trying.** Electron's main process is Node — an Electron app run from source under Deno is not a thing that exists, so there is nothing here to support.

## Updating from a terminal

The same update, without the app:

```bash
node node_modules/electron-git-updater/cli.js update
# or, if the bin is on PATH
electron-git-updater update [--repo <path>] [--no-risk]
```

It runs the generated script in the terminal you are already in, so the diff and the confirmation prompt are right there. Risky changes may be confirmed by default here, because by definition somebody is present to read them; `--no-risk` restores the plain refusal.

⭐ **Use this instead of a hand-written `update.sh`.** A script that does `git pull && npm install && npm run package` is precisely what the gate above exists to prevent, and a second, friendlier path around a safety gate is worse than no path at all — it is the one people reach for when the safe path says no.

## Docs

- [docs/Integration-guide.md](docs/Integration-guide.md) — wiring it into an app, step by step: build config, main, preload, UI, types, how to verify it, and what to do when it misbehaves
- [docs/How-it-works.md](docs/How-it-works.md) — the check, the generated script, the supply-chain gate, and why several obvious-looking approaches don't work

## Requirements

`git` on `PATH`, and on Windows the bash that comes with Git for Windows.
The app must be run from its git checkout, with its `package` script producing a build under `out/` — `out/*/*.app` on macOS, `out/*/*.exe` on Windows, the newest executable under `out/*/` on Linux.

This is deliberately **not** an updater for distributed, signed, notarized apps.
Use Squirrel or `electron-updater` for those.

## Optional: the built-in banner

`electron-git-updater/renderer` exports `mountUpdateBanner()`, a framework-agnostic drop-in banner, kept for convenience. Most apps should ignore it and render their own UI from the status object.

⚠️ **Whatever UI you render, key the update button on `riskConfirmable`, not on `risky` alone.** With `allowRiskyUpdates` on, a risky update is still offered — the update window prints the diff and asks for the phrase — so hiding the button there is a dead end that sends the user to a terminal to retype a command the app could have run. With it off, `apply()` comes back `blocked`, and a button that leads only to a refusal is worse than none. The built-in banner does this; a custom UI has to.
