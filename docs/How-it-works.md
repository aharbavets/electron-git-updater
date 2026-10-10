# How it works

The mechanics behind [`electron-git-updater`](../README.md), and the reasoning for the parts that look odd.
For wiring it into an app, see [Integration-guide.md](Integration-guide.md).

Almost every unusual decision here exists because the obvious version was tried first and failed in a way that looked like something else — an update button that did nothing, an app that swore it was current while running week-old code.
Those are recorded below next to the code that prevents them, because they are not obvious from reading the code alone.

## The shape of it

Three processes, one job each.

```
main process            preload             renderer
────────────            ───────             ────────
initGitUpdater()   →    exposeGitUpdater()  →   window.gitUpdater
  fetch + compare         contextBridge          your button
  run the update          3 functions            your badges
```

The main process does all the work; the preload exposes exactly three functions; the renderer draws whatever it likes.
No UI ships in the package (beyond an optional legacy banner) because the button is the part that differs in every app, and a package that owns it becomes a package you fight.

The IPC surface is three channels, exported as constants so you can watch them if you need to:

| Constant     | Channel              | Direction                                    |
| ------------ | -------------------- | -------------------------------------------- |
| `IPC_CHECK`  | `git-updater:check`  | renderer → main, `invoke`, returns a status  |
| `IPC_APPLY`  | `git-updater:apply`  | renderer → main, `invoke`, starts the update |
| `EVT_STATUS` | `git-updater:status` | main → renderer, pushed after every check    |

## Finding the checkout

`resolveRepoPath()` walks up from `app.getAppPath()`, then `process.execPath`, then `process.cwd()`, up to 40 levels, looking for a directory containing `.git`.

For the standard Forge layout that is enough: a packaged app sits at `out/<platform>/<App>.app/Contents/Resources/app.asar`, so walking up from it reaches the project root.
It is a heuristic, and `repoPath` overrides it.

## The check

`checkForUpdates(repoPath, buildCommit)` runs on a timer (15 minutes by default), about four seconds after launch, and on demand from the renderer.

1. **`git fetch --quiet`** — updates the remote-tracking refs without touching the working tree.
2. **Branch and upstream** — `rev-parse --abbrev-ref HEAD`, mapping the literal `"HEAD"` (a detached checkout) to `""`, and `@{upstream}` for what it tracks.
3. **The newest available commit** — the upstream tip, or local `HEAD` when the branch tracks nothing.
4. **The commit actually running** — `buildCommit` if it was passed _and_ still exists in the repo, otherwise `HEAD`.
5. **The distance** — `rev-list --count <built>..<latest>`.
6. **The most recently updated remote branch** — see below.
7. **The risk inspection** — only when there is something to update to.

Every git call runs with `GIT_TERMINAL_PROMPT=0` and a 60-second timeout.
Without that, a remote wanting credentials blocks on a prompt in a process with no terminal attached, and the check hangs forever instead of failing.
Failing is much better: a failure is reported and the UI stays neutral, while a hang looks like the app has frozen.

### Checking the updater against itself

The gate below means a fix released in this library does not arrive by updating the host app: the source is pulled and rebuilt, and `node_modules/electron-git-updater` is whatever it was.

Nothing looks wrong when that happens, which is what makes it worth a check.
A new tag does not change the host's `package.json` — the declared `#semver:` range already covers it — so the "what does the pull want to install" step is right to report no change, and the installed copy is behind all the same.
Measured 2026-10-08: a host app ran `1.0.0` for a day after `1.0.1` was tagged, failing on the exact bug `1.0.1` fixes, with every rebuild succeeding.

So after the ordinary check succeeds, `checkUpdaterVersion()` reads the newest `vX.Y.Z` tag from this library's own remote with `git ls-remote --tags` and compares it, numerically, against the installed version.
The result rides along as `status.updater`.

Three details decide whether it is useful rather than annoying:

- **It never rejects.** An unreachable remote, a repository with no tags, or no URL to try comes back as `error`. A courtesy check must not take the real one down.
- **It is skipped when the fetch failed**, because the network or the credentials are already the problem and a second remote call would only fail again.
- **It tries several addresses.** The host's declared dependency spec first, since that is the authority on where this copy came from; then — for a private package declared over HTTPS, where `git ls-remote` has no credentials in a GUI app's environment and fails outright — the same GitHub URL in SSH form; then this package's own `repository` field.

🚨 When it does report `outdated`, the advice matters as much as the warning.
`npm install` will **not** move a git dependency: `package-lock.json` pins the resolved commit and install honours the lock, so it reinstalls the same version and reports success.
The generated script therefore prints `npm update`, followed by the one-liner that reads back what actually landed.

### Why the build commit, and not HEAD

Comparing `HEAD` against the remote is the obvious design.
It is also wrong, in a way that hides itself.

Pull the source and do not rebuild: `HEAD` moves to the new commit while the running app still contains the old code.
The comparison now says "up to date" about a build that is anything but.
The user, who can see the new commits in the repo, presses Update and watches nothing happen.

So the comparison has to be _the commit the running binary was built from_ versus the newest available.
The build tool is the only thing that knows the former, so `buildCommitDefinePlugin` bakes it into the bundle as a compile-time constant.

The `commitExists()` guard matters here.
A baked commit can vanish from the repo — a rebase, a force-push, a fresh shallow clone — and `rev-list A..B` against a commit git does not have is a hard error, which would turn every check into a failure.
When the commit is unknown the code falls back to `HEAD` and reports `knowsBuildCommit: false`, so the degradation is visible rather than silent.

### The most-recently-updated branch

`mostRecentlyUpdatedBranch()` asks for the ten newest refs under `refs/remotes`, sorted by commit date, and takes the first that is not a `HEAD` pointer.
If that is not the branch you track, `onMostRecentBranch` is false and your UI can say so — the case it catches is sitting on a stale feature branch, faithfully updating to commits nobody has touched in a month.

One detail in that function is a trap worth naming, because it cost a debugging session.
`refs/remotes` also contains `refs/remotes/origin/HEAD`, a symbolic ref mirroring the default branch, which ties with it on commit date and sorts unpredictably against it.
It has to be filtered out — but `%(refname:short)` renders it as plain **`origin`**, not `origin/HEAD`.
Filtering on a `/HEAD` suffix of the short name therefore misses it entirely, `origin` wins the sort, no real branch ever equals it, and _every_ branch is reported stale including the one you are on.
The fix is to sort and filter on the **full** refname and shorten afterwards.

The bug is invisible in a scratch repo with one branch.
It only appears against a real remote — which is where it was found.

## The update

`apply()` does four things, in this order:

1. **Inspects the incoming commits for supply-chain risk**, and refuses outright if there is any.
2. **Writes a shell script to a temp file** and launches it.
3. **Waits for the launch to be confirmed** — not for the update, just for the window to open.
4. **Quits the app** 600 ms later, so the reply reaches the renderer first.

The script then waits for the app to die, pulls, builds, and reopens it.

### Why a visible Terminal

The update takes minutes and has several ways to fail: a dirty tree, a conflicting pull, a build error.
Run silently, all of them look identical from the outside — the app quits and nothing comes back.
That is indistinguishable from a crash on click, and it is what the first version did.

A Terminal window turns each step into something the user can see, and on failure the script deliberately **does not reopen the app**: a window popping up over the error is a window hiding the error.
It prints what failed, how to reopen the previous build, and waits for Enter.

### Why `open -a Terminal`, not `osascript`

Telling Terminal to run a script via `osascript` sends an Apple Event.
macOS blocks Apple Events unless the sending app ships `NSAppleEventsUsageDescription` **and** the user has granted Automation permission in System Settings.
When it is blocked, nothing happens at all: no window, no dialog, no error on stderr.

That is the actual root cause of the original "the Update button does nothing" bug, made worse by a `stdio: 'ignore'` that discarded the only evidence.
`open -a Terminal <script>` goes through Launch Services instead, which has no such gate.

On Windows the equivalent is `cmd /c start "" <bash> <script>`, which gives the script a console of its own.
The shell is Git Bash rather than `/bin/bash`: that path lives inside MSYS and is not visible to a native Windows process, so using it is how the update used to fail without saying anything.
`kill -0` is likewise unavailable there — MSYS process ids are its own, not Windows', so the wait step would see the app as already gone and let packaging race it. The Windows script asks `tasklist` instead.

The launch is awaited, so a failure surfaces as `{ started: false, error }` instead of the app quitting into silence.

### Why the script lives in /tmp

Two reasons, both learned rather than designed.

The package is bundled into `app.asar`, where loose files are not executable and `__dirname` has been rewritten by webpack — so shipping the script as a sibling file and running it does not work.

More subtly: **bash reads a script incrementally, not all at once.**
A script that lives inside the repo it is updating gets rewritten by `git pull` while it is still executing, and bash resumes at a byte offset in a file that has changed underneath it.
The consequences range from a syntax error to running a fragment of something else.
A copy in `/tmp` is untouched by the pull.

Values are baked into the generated script rather than passed as arguments, because `open -a Terminal` cannot forward arguments.

### What the script does

```
wait for the app to quit (up to 30 s, polling kill -0, or tasklist on Windows)
check for local changes      → warn and ask before continuing
git fetch, then git merge --ff-only @{u}
check what the pull wants to install → abort if anything did
                             → and say so if the updater itself is behind
npm run package
reopen the newest build under out/ (.app / .exe / executable)
```

It runs `set -uo pipefail` but deliberately not `set -e`: each step is checked individually so the failing one can be named.
"git pull failed" is a message someone can act on; a bare non-zero exit is not.

⚠️ **Not `git pull`.** It decides what to merge by reading `.git/FETCH_HEAD`, a scratch file git rewrites on every fetch and does not lock between processes.
A checkout shared with an IDE, a coding agent, or a second copy of this script can have two fetches land in that file at once; the same branch is then listed twice and every later pull dies with `fatal: Cannot fast-forward to multiple branches`.
`--ff-only` does not help, because it constrains the result of the merge while the damage is in the input.
Merging the branch's configured upstream directly never opens FETCH_HEAD at all.

The dirty-tree check is first among the real steps because it is the most common failure by far.
`git pull` refuses rather than clobbering local edits, and saying so up front is better than a cryptic failure three steps in.

## The supply-chain gate

`npm install` executes `preinstall` and `postinstall` scripts from **every** package in the tree, with your permissions, on your machine.
So a commit that adds a dependency is a commit that runs code here — and anyone who can push to the remote can write that commit.
An updater that pulls and installs unattended is a remote code execution channel with a nice button on it.

The check exists in two places, and they compare different things on purpose.

`inspectIncomingRisk()` — the one behind `status.risky`, used to flag the update in the app's UI — compares `package.json` at `HEAD` against the one at `@{upstream}`. It answers "what is coming in", which is the right question for a badge, and deliberately ignores the working tree so that your own half-finished edits do not light it up.

🚨 **The gate inside the update script compares against the working tree instead**, because that is what `npm install` reads. The two were once the same comparison, and the difference was reachable: an upstream commit touching only `package-lock.json` fires the gate, the `package.json` diff prints **empty** because nothing changed in the commits, and an uncommitted `postinstall` sitting in the working tree is then run by the install — never having been shown to the person who typed the phrase. Reviewing `HEAD` while installing the working tree is reviewing the wrong thing.

A consequence worth knowing: a purely local, uncommitted dependency change now trips the gate even when nothing is coming in. That is the intended trade — it is still a change that `npm install` would act on.

Either way, the flags raised are the same three:

- an npm lifecycle hook **added or changed** — `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, `prepack`, and the rest of the list;
- a **brand-new** dependency in any of the four dependency fields;
- an existing dependency **repointed at a non-registry source** — git, url, tarball, or local path, all of which bypass registry review.

When any of those appear, the update **does not run**.
`apply()` returns `{ started: false, blocked: true, reasons }` before touching the checkout — nothing is pulled, nothing is installed, no Terminal opens — and the same finding is reported in `status.risky` / `status.reasons` on every check, so a UI can flag it before anyone clicks.
The generated script carries a second copy of the check for the same reason, in case something changes between the check and the pull.

Called directly, it compares against whatever the remote-tracking ref already holds — **it does not fetch**.
`checkForUpdates()` fetches before calling it, so the normal path is current; a bare call on a stale ref sees nothing incoming and reports `risky: false`.

**The gate cannot be switched off**, and the default cannot be loosened.
An early version did have an option that defaulted to "ask instead of block", and that was wrong: a default is wrong exactly once, and a gate that protects you only when you remembered to turn it on is not a gate.

What exists now is narrower, and the difference is the part that matters.
`allowRiskyUpdates` does not disable the check and does not make the update unattended — it moves the refusal from the app into the update script, where the `package.json` diff is already printed and a person has to type a phrase in full before anything is installed:

```
Type REVIEWED to install and build anyway, anything else to stop:
```

So the thing that was rejected was *asking in a dialog instead of blocking*, which turns a safety gate into a click.
Asking in a terminal, under the diff, with no default answer and no keystroke that means yes, is the informed consent the gate was protecting in the first place.
It still defaults to off, because loosening a supply-chain default on a library's say-so is its own mistake.

Either way, finishing by hand is one command, after reading a diff you should read anyway:

```bash
node node_modules/electron-git-updater/cli.js update
```

The gate is a heuristic and it knows it.
It reads `package.json`, not the code, so a malicious change to an existing file sails past — this narrows one specific, well-known vector, it does not make pulling from a remote safe.
It also has false positives: an ordinary new dependency trips it. That is the intended trade, since the cost is doing the update manually.

## Failure philosophy

Two rules run through the whole package.

**A failed check is ordinary.**
Offline, no upstream, not a checkout, a laptop that woke up on a captive-portal wifi — all normal.
They produce a status with an `error` field and leave everything else neutral, so the UI shows its resting state rather than alarming anyone about a network blip.

**A failed update is not ordinary and must be visible.**
It keeps the Terminal window open, names the step that failed, and refuses to reopen the app over the top of the message.
