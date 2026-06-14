# electron-git-updater

A tiny, framework-agnostic, **drop-in** auto-updater for Electron apps that run
**from a git checkout** (i.e. the user has the source and rebuilds locally,
rather than receiving signed installer artifacts).

It does three things:

1. Periodically runs `git fetch` and reports how many commits the local branch
   is **behind its upstream** — the "update available" signal.
2. Shows a small **localized banner** ("Доступно обновление" / "Update
   available" / …) only when an update is available.
3. On click, runs an `update-and-restart` routine: waits for the app to quit,
   `git pull` → (conditionally) `npm ci` → `npm run package` → relaunch the
   freshly built `.app`.

> **Not** a replacement for `electron-updater`. If you ship **signed installer
> artifacts** to third parties, use `electron-updater`/Squirrel instead. This is
> for source-run / internal / personal apps where the machine already has the
> dev toolchain and the git repo.

## Why git-based?

The standard Electron updaters (`electron-updater`, `update-electron-app`,
Squirrel) all assume packaged, code-signed release artifacts on a feed. If your
distribution model is literally "the user does `git pull && npm install && npm
run package`", none of them apply — hence this package.

## Install

Add it as a git dependency (works with your SSH key):

```jsonc
// package.json
"dependencies": {
  "electron-git-updater": "https://github.com/aharbavets/electron-git-updater.git#main"
}
```

For local development before the repo is pushed:

```sh
npm install /path/to/electron-git-updater
```

## Wire-up (three lines, three processes)

**Main process** — after creating the window:

```ts
import { initGitUpdater } from 'electron-git-updater/main';

const mainWindow = new BrowserWindow({ /* … */ });
initGitUpdater({ window: mainWindow }); // repo path is auto-detected
```

**Preload**:

```ts
import { exposeGitUpdater } from 'electron-git-updater/preload';
exposeGitUpdater(); // adds window.gitUpdater (does not touch window.electron)
```

**Renderer** — once, on app mount:

```ts
import { mountUpdateBanner } from 'electron-git-updater/renderer';
mountUpdateBanner({ locale: 'ru' }); // or omit to follow navigator.language
```

That's it. The banner appears only when there are incoming commits.

## Options

`initGitUpdater(options)`:

| option        | default      | meaning                                            |
|---------------|--------------|----------------------------------------------------|
| `window`      | `null`       | window to push status events to                    |
| `repoPath`    | auto-detect  | source checkout (walks up from the app to `.git`)  |
| `intervalMs`  | `1_800_000`  | re-check cadence (30 min); `0` disables polling    |
| `checkOnStart`| `true`       | run an initial check ~4s after launch              |
| `onError`     | `console.error` | error sink                                      |

`mountUpdateBanner(opts)`:

| option     | default              | meaning                                  |
|------------|----------------------|------------------------------------------|
| `locale`   | `navigator.language` | which built-in translations to use       |
| `messages` | `{}`                 | override any string explicitly           |
| `api`      | `window.gitUpdater`  | the exposed bridge                       |

Built-in locales: en, ru, be, uk, pl, de, es, fr (override any via `messages`).

## How relaunch works (packaged build)

When packaged, `app.getAppPath()` points inside
`out/…/App.app/Contents/Resources/app.asar`; the package walks up that path
until it finds the project's `.git`, so the running app knows which checkout to
update. The update script is written to a temp file and run **detached**, so it
outlives the app it's about to repackage. It reopens the newest `out/*/*.app`.

This is macOS-focused (`open`, `.app`). Windows/Linux relaunch is a TODO.

## ⚠️ Supply-chain safety

The update routine runs `npm ci`, and **npm install scripts execute arbitrary
code**. A poisoned upstream commit would otherwise run on every user's machine
automatically, with no human reviewing the diff. Mitigations baked in:

- **Risky updates are not auto-applied.** Before offering the one-click button,
  the updater diffs the incoming `package.json` against the upstream one. If it
  finds any of:
    - an added or changed npm **lifecycle hook** (`preinstall`, `install`,
      `postinstall`, `prepare`, `prepack`, …),
    - a **brand-new dependency**, or
    - a dependency switched to a **non-registry source** (git/url/tarball/file),

  the banner switches to a **warning** that lists exactly what changed and asks
  the user to **review and update manually** — no auto-update button is shown.
  The main process also refuses `apply()` for a risky range (defense-in-depth),
  so a forced call can't bypass it. This is exactly the case that would have
  caught the `postinstall: curl … | sh` worm.
- `npm ci` runs **only when `package.json`/`package-lock.json` changed** in the
  pulled range — most updates skip install entirely.
- Commit and trust your `package-lock.json`; run `npm audit` regularly.
- Restrict who can push to the branch users track.

Programmatic access if you want your own gate:

```ts
import { inspectIncomingRisk } from 'electron-git-updater/main';
const { risky, reasons } = await inspectIncomingRisk('/path/to/checkout');
```
