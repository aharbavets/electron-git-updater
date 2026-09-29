---
created: 2026-09-28
status: backlog
priority: normal
---

# apply() reports success on Windows when the update never starts

`spawnUpdate()` in [`main.js`](../main.js) falls back to `spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' })` on every non-macOS platform.
On Windows there is usually no `/bin/bash`, and the failure is worse than an error message.

**The symptom.** `spawn` reports a missing executable on an asynchronous `error` event, which arrives *after* `apply()` has already resolved `{ started: true }` and scheduled `app.quit()` 600 ms later.
So the app shuts down, nothing updates, the renderer was told it succeeded, and the main process takes an unhandled `error` event on the way out.
Nothing in the UI can distinguish this from a normal update that is about to relaunch.

**The fix is small** — attach a handler to the child before returning, and resolve or reject from it rather than from `spawn` returning:

```js
const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
child.on('error', reject);
child.once('spawn', () => { child.unref(); resolve(); });
```

That makes the documented behaviour true: `apply()` returns `{ started: false, error }` instead of quitting into silence.

**Two things to decide while in there**, rather than fixing only the crash:

- The generated script assumes `npm run package` produces `out/*/*.app`, which is a macOS bundle. Even with a working shell, Linux and Windows reach the reopen step and find nothing. See the "Limits worth knowing up front" section of [`docs/Integration-guide.md`](../docs/Integration-guide.md).
- There is no visible Terminal off macOS at all, so a failure is invisible by design. Either give Windows a `start cmd /k` equivalent, or have `initGitUpdater` report the platform as unsupported so a host app can hide its Update button instead of offering one that cannot work.

**Not urgent:** every current consumer is macOS. This is written down because the docs now state the behaviour and the behaviour is a bug, so the next reader will otherwise assume the error path works.
