# electron-git-updater — Claude Guide

Drop-in git-pull auto-updater library for source-run Electron apps (main /
preload / renderer split, zero runtime deps). See [README.md](README.md) for the
API and the supply-chain-safety behavior,
[docs/Integration-guide.md](docs/Integration-guide.md) for how it is wired into a host app,
and [docs/How-it-works.md](docs/How-it-works.md) for the mechanics.

Keep those two docs in step with the code: they document exact behavior
(option defaults, the generated script's steps, what the risk check flags),
so a change to any of that is a change to them.

## Commits

**The programmer makes all git commits — do not commit on your own.** Do not run
`git commit` / `git commit --amend` or `git push`. When the work reaches a
sensible commit point, you may invoke the `/commit` skill to generate a commit
message; leave the actual commit (and push) to the programmer.
