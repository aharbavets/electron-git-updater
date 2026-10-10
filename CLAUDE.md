# electron-git-updater — Claude Guide

Drop-in git-pull auto-updater library for source-run Electron apps (main /
preload / renderer split, zero runtime deps). See [README.md](README.md) for the
API and the supply-chain-safety behavior,
[docs/Integration-guide.md](docs/Integration-guide.md) for how it is wired into a host app,
and [docs/How-it-works.md](docs/How-it-works.md) for the mechanics.

Keep those two docs in step with the code: they document exact behavior
(option defaults, the generated script's steps, what the risk check flags),
so a change to any of that is a change to them.

## 🚨 This repository is public

Everything committed here is readable by anyone, including the history — a secret removed in a later commit is still in the earlier one.

So, before writing anything into this repository:

- **Do not name other projects.** Not in docs, not in comments, not in commit messages. Two such names reached this repository and had to be purged from the whole history, which meant a force-push and re-pinning every consumer's lockfile — and the names cannot be repeated here, because writing them into the rule would put them straight back. The general form of the sentence is almost always as good: say "a real integration" rather than naming the app, "a house proportion kept fixed across icons" rather than naming where it came from.
- **No private paths, hostnames, internal URLs or ticket numbers.**
- **Install instructions use HTTPS**, not `git+ssh`. SSH is right for a private package and wrong for a public one: it demands a key from people who only want to read.
- A screenshot or a contact sheet is content too — check what is in frame.

Nothing here is secret by nature; the risk is incidental disclosure of what else exists and what it is called.

## Commits

**The programmer makes all git commits — do not commit on your own.** Do not run
`git commit` / `git commit --amend` or `git push`. When the work reaches a
sensible commit point, you may invoke the `/commit` skill to generate a commit
message; leave the actual commit (and push) to the programmer.
