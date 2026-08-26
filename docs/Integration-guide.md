# Integration guide

How to wire `electron-git-updater` into an Electron app, from nothing to a working Update button — and how to prove it works rather than assume it does.

Four places in your app change: the build config, the main process, the preload script, and wherever you want the button.
None of them is more than a few lines.
The rest of this guide is the details that decide whether it works on the second day as well as the first.

For what happens under the hood, see [How-it-works.md](How-it-works.md).

## 0. Does this fit your app?

This updater is for apps that **run from their own git checkout**.
That is a narrow shape, and it is worth checking before you wire anything up.

It fits when all of these are true:

- The app lives in a git repo on the machine that runs it, with a remote it can `git fetch` from.
- It is built with `npm run package`, and the result lands in `out/<anything>/<Something>.app`.
- It runs on macOS, or you accept a silent background update elsewhere (see [Platform support](#platform-support)).
- `git` is on `PATH`, and the remote authenticates without an interactive prompt — an SSH key or a cached credential helper.
- The people running it can live with an update that takes as long as a full rebuild, in a Terminal window they can see.

It does **not** fit a signed, notarized app distributed as a `.dmg` or an installer to users who never see the source.
Those want [`electron-updater`](https://www.electron.build/auto-update) or Squirrel, which ship diffs of a built artifact rather than rebuilding from source.
This package is a developer-and-small-team tool: it makes "I pushed a fix, pull and rebuild" into one button.

## 1. Install

```bash
npm i git+https://github.com/aharbavets/electron-git-updater.git#main
```

No runtime dependencies.
`electron >= 16` is a peer dependency, and `git` is expected on `PATH` at runtime.

## 2. The four wiring points

| Process          | Typical file             | What you add                                   |
| ---------------- | ------------------------ | ---------------------------------------------- |
| **Build config** | `webpack.main.config.ts` | `buildCommitDefinePlugin()` — bakes the commit |
| **Main**         | `src/index.ts`           | `initGitUpdater({ window, buildCommit })`      |
| **Preload**      | `src/preload.ts`         | `exposeGitUpdater()` — exposes the bridge      |
| **Renderer**     | your own component       | reads `window.gitUpdater`                      |

They run in different processes, so import each from its own subpath.
Importing `electron-git-updater/main` in the renderer pulls Electron's main-process API into a browser context and fails.

### Step 1 — bake the build commit into the bundle

This is the step that is easy to skip and the one that makes the whole thing work.
The updater compares **the commit the running binary was built from** against the newest available commit.
Comparing `HEAD` instead reports the app up to date the moment someone pulls without rebuilding — which is exactly the moment an update is needed.

**Webpack** (Electron Forge's webpack template):

```ts
// webpack.plugins.ts
import webpack from "webpack";
import { buildCommitDefinePlugin } from "electron-git-updater/webpack";

export const plugins = [
  buildCommitDefinePlugin({ cwd: __dirname, webpack }),
  // …your other plugins
];
```

Both arguments earn their place.
`cwd: __dirname` asks git about **your project**, not about whatever working directory the build tool happened to inherit.
`webpack` is passed explicitly because webpack is the host app's dependency, not this package's — without it the plugin has to `require('webpack')` from inside `node_modules/electron-git-updater`, which resolves in a flat install and fails in a linked or nested one.
Pass it and the question never comes up.

Make sure the plugin lands in the **main** process config.
In the Forge template, `webpack.main.config.ts` imports `plugins` from `webpack.plugins.ts`, so adding it there is enough — but check, because the same file is often shared with the renderer config.

**Vite** (Forge's Vite template):

```ts
// vite.main.config.ts
import { defineConfig } from "vite";
import { currentCommit } from "electron-git-updater/webpack";

export default defineConfig({
  define: { BUILD_COMMIT: JSON.stringify(currentCommit()) },
});
```

**esbuild**:

```js
const { currentCommit } = require("electron-git-updater/webpack");

esbuild.build({
  define: { BUILD_COMMIT: JSON.stringify(currentCommit()) },
});
```

**No bundler for the main process** — generate a tiny module before packaging:

```json
{
  "scripts": {
    "prepackage": "node -e \"const{currentCommit}=require('electron-git-updater/webpack');require('fs').writeFileSync('src/buildCommit.js','module.exports='+JSON.stringify(currentCommit())+'\\n')\""
  }
}
```

```js
const buildCommit = require("./buildCommit");
initGitUpdater({ window, buildCommit });
```

Two things to know about the baked value, whichever route you take:

- **It is a compile-time substitution, not an import.** In TypeScript you `declare const BUILD_COMMIT: string` — declaring a value the bundler will replace. There is nothing to import and nothing at runtime to resolve.
- **It is the commit, not your working tree.** Build with uncommitted edits and the constant is still the last commit. That is fine for staleness detection, but it means a dirty build is indistinguishable from a clean one at that commit.

Skipping this step is survivable, not fatal: the package falls back to `HEAD` and reports `knowsBuildCommit: false`, so your UI can say the detection is degraded rather than quietly lying.

### Step 2 — the main process

```ts
import { app, BrowserWindow } from "electron";
import { initGitUpdater } from "electron-git-updater/main";

/** Injected by buildCommitDefinePlugin — see webpack.plugins.ts. */
declare const BUILD_COMMIT: string;

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    webPreferences: { preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY },
  });
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  initGitUpdater({ window: mainWindow, buildCommit: BUILD_COMMIT });
};

app.on("ready", createWindow);
```

Call it **after** the window exists, so status pushes have somewhere to go.
Calling it again — when macOS recreates the window on `activate`, for instance — is safe: the IPC handlers are removed and re-registered rather than colliding.

Every option, with its default:

```ts
initGitUpdater({
  window: null, // BrowserWindow to push status events to
  buildCommit: null, // from ./webpack; null falls back to HEAD
  repoPath: null, // null = walk up from the app bundle to the .git root
  intervalMs: 15 * 60 * 1000, // re-check interval; 0 disables the timer
  checkOnStart: true, // one check ~4 s after launch
  onError: (message, error) => console.error("[git-updater]", message, error),
});
```

`repoPath` is auto-detected by walking up from `app.getAppPath()`, then `process.execPath`, then `process.cwd()`, looking for a `.git`.
For the normal `out/<platform>/<App>.app` layout that lands on the project root.
Set it explicitly if your build output lives outside the repo, or if the app is symlinked somewhere unusual.

`onError` is worth wiring to whatever logging you already have.
It is called for a failed check (offline, no upstream, not a checkout), for a failed launch of the update, and — importantly — when an update is **blocked** by the supply-chain gate.
Without it those go to `console.error` in the main process, which nobody reads.

The return value gives you `check()` for a manual refresh, the resolved `repoPath`, and `stop()` to tear the whole thing down.

### Step 3 — the preload script

```ts
import { exposeGitUpdater } from "electron-git-updater/preload";

exposeGitUpdater(); // window.gitUpdater
```

Pass a name to expose it elsewhere: `exposeGitUpdater("updater")` → `window.updater`.
It only ever adds its own key, so an existing `window.electron` bridge is untouched.

This needs `contextIsolation` **enabled**, which has been the Electron default since v12.
`contextBridge.exposeInMainWorld` is unavailable without it, and the renderer will find no `window.gitUpdater`.

The renderer gets exactly three functions and nothing else:

```ts
window.gitUpdater.check(); // Promise<UpdateStatus> — force a check now
window.gitUpdater.apply(); // Promise<{ started, blocked?, reasons?, error? }>
window.gitUpdater.onStatus(callback); // subscribe; returns an unsubscribe function
```

### Step 4 — the UI

There is no built-in UI on purpose, because this part differs in every app.
You get a status object; you decide what it looks like.

The states worth handling:

| Status                      | What to show                                             |
| --------------------------- | -------------------------------------------------------- |
| `available: false`          | a plain, quiet Update button — or nothing at all         |
| `available: true`           | the same button, made loud: green, "Update available"    |
| `risky: true`               | a warning that the update is withheld, with `reasons`    |
| `onMostRecentBranch: false` | "you are on a stale branch", naming `mostRecentBranch`   |
| `knowsBuildCommit: false`   | optional: detection is degraded, staleness may be missed |
| `error`                     | usually nothing — a failed check is ordinary             |

React, close to a real integration:

```tsx
const [status, setStatus] = useState<UpdateStatus | null>(null);
const [message, setMessage] = useState("");

// onStatus returns its own unsubscribe function, so it can be the cleanup.
useEffect(() => window.gitUpdater?.onStatus(setStatus), []);

const update = async () => {
  const result = await window.gitUpdater?.apply();
  if (result && !result.started) {
    setMessage(
      result.blocked
        ? `Update withheld — incoming commits change dependencies: ${result.reasons?.join("; ")}`
        : (result.error ?? "Could not start the update."),
    );
  }
  // On success the app quits within a second; nothing more to do here.
};

return (
  <>
    <button
      className={
        status?.available ? "btn btn-success" : "btn btn-outline-primary"
      }
      onClick={update}
    >
      {status?.available ? "Update available" : "Update"}
    </button>

    {status?.risky && (
      <span
        className="badge text-bg-warning"
        title={status.reasons?.join("\n")}
      >
        Update withheld — review it yourself
      </span>
    )}

    {status && status.onMostRecentBranch === false && (
      <span className="badge text-bg-danger">
        Newer commits are on {status.mostRecentBranch}
      </span>
    )}
  </>
);
```

Note `status.onMostRecentBranch === false` rather than `!status.onMostRecentBranch`.
The field is absent on an error status, and `!undefined` would light the warning up every time the check simply failed.

Without a framework:

```js
window.gitUpdater.onStatus((status) => {
  button.textContent = status.available ? "Update available" : "Update";
  button.classList.toggle("is-available", status.available);
});
button.addEventListener("click", () => window.gitUpdater.apply());
```

If you want something on screen in the next five minutes rather than a designed button, `electron-git-updater/renderer` still ships `mountUpdateBanner()` — a plain-DOM banner, Bootstrap-styled if Bootstrap is present, translated into eight languages, which hides itself when there is nothing to report and switches to a "review this yourself" message when the update is risky:

```js
import { mountUpdateBanner } from "electron-git-updater/renderer";

const unmount = mountUpdateBanner({ locale: "en" });
```

It is a convenience, not the recommended path.
Most apps outgrow it as soon as they have an opinion about where the button goes.

### Step 5 — types

The bridge is typed, so tell TypeScript about the global:

```ts
// src/global.d.ts
import { GitUpdaterBridge } from "electron-git-updater/preload";

declare global {
  interface Window {
    /** Injected by the preload script. Undefined outside Electron. */
    gitUpdater?: GitUpdaterBridge;
  }
}

export {};
```

Keep it optional (`?`).
Renderers get opened outside Electron more often than you expect — a plain `npm start` for styling work, a test runner — and an optional field turns that from a crash into a disabled button.

The subpath types resolve under both classic `moduleResolution: "node"` and the modern `"node16"` / `"bundler"` modes, because each `.d.ts` sits next to the `.js` it describes at the package root.
No `paths` mapping needed.

## 3. Verify it

Six checks, in order of how much they tell you.
The last two are the ones that catch the bugs this package was written to fix.

**1. The bridge is there.** In DevTools:

```js
await window.gitUpdater.check();
```

You should get a status object.
`undefined` means the preload never ran — check `webPreferences.preload` and `contextIsolation`.

**2. The commit is baked in.** In that same object, `knowsBuildCommit` must be `true`.
If it is `false`, Step 1 did not take effect, and the app cannot tell a stale build from a current one.
You can also read the value straight out of a packaged build:

```bash
grep -ao 'buildCommit:"[0-9a-f]*' out/*/*.app/Contents/Resources/app.asar
```

`-a` matters — without it grep treats the asar as binary and tells you nothing.
Grepping for the bare SHA is not enough either: an asar is full of unrelated 40-character hashes from the lockfile, and the commit you are looking for may legitimately differ from `HEAD` (that is the whole point — it is the commit that build was made from).

**3. It notices a new commit.** Push a trivial commit from anywhere, then re-check: `behind` should be at least 1 and `available` true.

**4. It notices a pulled-but-not-rebuilt tree.** This is the case a naive `HEAD` comparison gets wrong.
With the app still running, `git pull` in the checkout and **do not rebuild**.
The app must still report `available: true`.
If it flips to up-to-date, the build commit is not reaching `initGitUpdater`.

**5. The supply-chain gate actually blocks.** You do not need a real attack to test this.
The package ships a script that builds a throwaway repo whose upstream carries a commit adding a `postinstall` hook and a git-sourced dependency, then runs the risk check against it:

```bash
./node_modules/electron-git-updater/scripts/verify-supply-chain-gate.sh
```

```
{ "risky": true,
  "reasons": [ "install hook added: \"postinstall\"", "new dependencies: evil" ] }
```

It exits non-zero if the gate fails to fire, so it works in CI.
Nothing it does touches your own repo.

Two things about calling `inspectIncomingRisk()` yourself, both of which will otherwise waste an afternoon:

- **It does not fetch.** It compares `HEAD` against `@{upstream}`, the local remote-tracking ref, so without a preceding `git fetch` it sees nothing incoming and cheerfully reports `risky: false`. `checkForUpdates()` fetches first; the bare function does not.
- **It still needs `electron` to be importable**, because `main.js` requires it at module load, even though the risk check itself only shells out to git. In a plain Node process a two-line stub is enough — that is what the script above does.

For the full path, call the `git-updater:apply` handler and confirm it returns `{ started: false, blocked: true, reasons }` — and that the repo was **not** pulled.

**6. Press the button.** A Terminal window opens, the steps scroll past, the app quits and reopens on the new build.
Break it on purpose once: leave an uncommitted edit in the checkout and press Update.
You should get the dirty-tree warning and a prompt, not a cryptic failure.

## 4. Troubleshooting

| Symptom                                                         | Cause                                                          | Fix                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `window.gitUpdater` is `undefined`                              | preload not loaded, or `contextIsolation: false`               | check `webPreferences.preload`; leave `contextIsolation` at its default                    |
| Always "up to date" though the source moved                     | `knowsBuildCommit: false` — the commit was never baked in      | revisit Step 1; confirm the plugin is in the **main** config                               |
| Nothing happens on Update, no Terminal                          | `open -a Terminal` failed                                      | read `onError`; `apply()` returns `{ started: false, error }` rather than failing silently |
| Update returns `blocked: true`                                  | incoming commits change dependencies or install hooks          | by design — read the diff, then `git pull && npm install && npm run package` by hand       |
| Red "not on a recently updated branch" that never clears        | another remote branch has newer commits than the one you track | switch branch, or ignore it — it is information, not an error                              |
| `status.error` mentioning `no upstream`                         | the current branch tracks nothing                              | `git branch -u origin/<branch>`                                                            |
| The check fails instead of hanging on a credential prompt       | intentional — `GIT_TERMINAL_PROMPT=0` is set                   | give the remote an SSH key or a credential helper                                          |
| Terminal opens, then "cancelled — commit or stash your changes" | dirty working tree, and you declined the prompt                | commit or stash first                                                                      |
| Terminal says "No built app found under out/"                   | `npm run package` did not produce `out/*/*.app`                | see the layout assumption below                                                            |

## 5. Limits worth knowing up front

**The generated script is not configurable.**
It hard-codes `npm run package` and looks for the newest `out/*/*.app` to reopen.
A different build command or output layout means the build step fails or the reopen finds nothing — the pull still happens, and the Terminal window stays open saying so.
`buildUpdateScript()` is exported if you want to read exactly what runs; it is not currently swappable at init time.

<a id="platform-support"></a>**Platform support is macOS-first.**
On macOS the update runs in a visible Terminal via Launch Services.
Elsewhere it is spawned detached through `/bin/bash` with no output anywhere, which works on Linux but makes any failure invisible.

On Windows there is usually no `/bin/bash` at all, and the failure mode is worse than an error message: `spawn` reports a missing executable on an asynchronous `error` event, which arrives after `apply()` has already resolved `{ started: true }` and scheduled the quit.
The app shuts down, nothing updates, and the main process takes an unhandled error on the way out.
Treat non-macOS as unfinished rather than supported, and gate the button on `process.platform === "darwin"` if your app ships there.

**The app quits to update.**
It has to: packaging writes over the bundle that is running.
Anything unsaved in the renderer needs persisting before `apply()` — this package will not ask.

**One checkout, one machine.**
There is no notion of channels, rollbacks, or staged rollout.
What you get is the commit your remote branch points at, built here.
