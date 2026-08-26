# electron-git-updater

Auto-update for Electron apps that are **run from their own source checkout** — the pattern where the app lives in a git repo, is packaged with `npm run package`, and is launched from `out/`. It notices when the running build is behind the source, and on request pulls, reinstalls, rebuilds and relaunches in a **visible Terminal window**.

It ships **no UI**. The main process reports a status object; your app draws whatever button, badge or banner suits it, because that part is different in every app.

## Install

```bash
npm i git+https://github.com/aharbavets/electron-git-updater.git#main
```

## Wire it up

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
| `knowsBuildCommit`                        | false when no `buildCommit` was passed, so staleness was measured from `HEAD` and a stale build can't be detected |
| `error`                                   | the check couldn't run — offline, no upstream, not a checkout                                                     |

A failed check is ordinary. Leave the UI neutral rather than alarming anyone.

## Why the build commit matters

Comparing `HEAD` with the remote is the obvious approach and it is **wrong**. Pull the source without rebuilding and `HEAD` moves while the running app keeps the old code — so the app reports itself up to date while running stale, and the update button appears to do nothing.

So the comparison is _the commit the running binary was built from_ versus the newest available. The webpack plugin bakes the former in at build time. Without it the package falls back to `HEAD` and sets `knowsBuildCommit: false`.

## Why a Terminal window

The update takes minutes and can fail — a dirty tree, a conflicting pull, a broken build. Run silently, that looks exactly like the app crashing on click. The Terminal shows each step, and on failure it **keeps the window open and does not reopen the app**, so the error isn't hidden behind a window popping up over it.

macOS uses `open -a Terminal`, not `osascript`. Scripting Terminal sends an Apple Event, which macOS blocks unless the app ships `NSAppleEventsUsageDescription` _and_ the user has granted Automation permission — and when blocked, **nothing happens at all**: no window, no error. Launch Services has no such gate. Other platforms fall back to a detached background run.

## Supply-chain gate

`npm install` executes `preinstall` / `postinstall` scripts from every package, so a commit that adds a dependency is a commit that runs code on your machine. Anyone who can push to the remote can do that.

The updater therefore inspects incoming commits for:

- added or changed npm lifecycle hooks,
- brand-new dependencies,
- dependencies switched to a non-registry source (git, url, tarball, local path).

**When any of those are found, the update does not run.** It is reported in `status.risky` / `status.reasons` so your UI can flag it, and `apply()` returns `{ started: false, blocked: true, reasons }` without touching anything. Finish by hand once you have read the diff:

```bash
git pull && npm install && npm run package
```

**This is not configurable, deliberately.** Carrying such a commit through unattended is the whole attack, so there is no option to switch the gate off and no default to get wrong. A setting like that only has to be wrong once.

## Options

```ts
initGitUpdater({
  window, // where to push status events
  buildCommit, // from ./webpack — see above
  repoPath, // default: walk up from the app bundle to the .git root
  intervalMs: 15 * 60_000, // re-check interval; 0 disables
  checkOnStart: true,
  onError,
});
```

## Requirements

macOS for the Terminal flow (other platforms update silently in the background). The app must be run from its git checkout with `npm run package` producing `out/*/*.app` — this is deliberately **not** an updater for distributed, signed, notarized apps. Use Squirrel or `electron-updater` for those.

## Optional: the built-in banner

`electron-git-updater/renderer` exports `mountUpdateBanner()`, a framework-agnostic drop-in banner, kept for convenience. Most apps should ignore it and render their own UI from the status object.
