import type { BrowserWindow } from "electron"

/** What the updater knows about the checkout, pushed to the renderer. */
export interface UpdateStatus {
    /** True when the running build is behind the newest available commit. */
    available: boolean
    /** Commits between the build being run and the newest available one. */
    behind: number
    /** Current branch, or "" on a detached HEAD. */
    branch?: string
    /** Remote branch the current one tracks, e.g. "origin/main". */
    upstream?: string
    /** Remote branch with the newest commit. */
    mostRecentBranch?: string
    /** False when another branch has newer commits than the one checked out. */
    onMostRecentBranch?: boolean
    /** Commit this build was made from, when known. */
    builtCommit?: string | null
    /**
     * False when no buildCommit was supplied, so staleness was measured from
     * HEAD and a pulled-but-not-rebuilt app cannot be detected.
     */
    knowsBuildCommit?: boolean
    /** True when incoming commits change dependencies or install hooks. */
    risky?: boolean
    /** Human-readable list of what makes it risky. */
    reasons?: string[]
    /** Set when the check could not run (offline, no upstream, not a checkout). */
    error?: string
    /**
     * True when `git fetch` failed; the report then comes from the last-fetched
     * remote-tracking refs rather than aborting.
     */
    fetchFailed?: boolean
    /** The fetch error output, when `fetchFailed`. */
    fetchError?: string
    /**
     * True when the fetch failed for a credentials/permission reason — e.g. a
     * GUI app whose environment has no ssh-agent.
     */
    fetchAuthFailed?: boolean
    /**
     * True when the tracked remote uses SSH. Switching it to HTTPS is the usual
     * fix for `fetchAuthFailed` on a GUI app.
     */
    remoteIsSsh?: boolean
    /**
     * Whether the updater library itself is behind its newest released tag.
     * Absent when the fetch failed, since the check is skipped then.
     */
    updater?: UpdaterVersion
}

/** How the installed copy of this library compares with its newest tag. */
export interface UpdaterVersion {
    /** Version of this library as installed in the host app. */
    installed: string
    /** Newest `vX.Y.Z` tag on its remote, or null when none could be read. */
    latest: string | null
    /** True when a newer tag exists than the installed version. */
    outdated: boolean
    /** Why the check could not answer — unreachable remote, no tags, no URL. */
    error?: string
}

export interface InitOptions {
    /** Window to push status events to. */
    window?: BrowserWindow | null
    /** Commit this build was made from — see electron-git-updater/webpack. */
    buildCommit?: string | null
    /** Explicit source checkout path; auto-detected by default. */
    repoPath?: string | null
    /** Re-check interval in ms. Default 15 min; 0 disables. */
    intervalMs?: number
    /** Run a check shortly after launch. Default true. */
    checkOnStart?: boolean
    /**
     * Let an update that changes dependencies or install scripts go ahead
     * after the person running it types the confirmation phrase. Default
     * false, which refuses outright.
     *
     * This does not remove the supply-chain gate — it moves the decision into
     * the update script, where the diff is on screen while it is made.
     */
    allowRiskyUpdates?: boolean
    /** Phrase to type to confirm such an update. Default `REVIEWED`. */
    riskPhrase?: string
    onError?: (message: string, error: unknown) => void
}

export interface Updater {
    check(): Promise<UpdateStatus>
    repoPath: string
    stop(): void
}

export declare function initGitUpdater(options?: InitOptions): Updater
export declare function checkForUpdates(repoPath: string, buildCommit?: string): Promise<UpdateStatus>
/**
 * Whether the installed copy of this library is behind its newest released tag.
 *
 * This library is usually the host app's only git dependency, and such a
 * dependency goes stale silently: a new tag does not change `package.json`, so
 * nothing reports it. Never rejects — an unreachable remote comes back as
 * `error`.
 */
export declare function checkUpdaterVersion(repoPath: string): Promise<UpdaterVersion>

export declare function inspectIncomingRisk(repoPath: string): Promise<{ risky: boolean; reasons: string[] }>
export declare function resolveRepoPath(explicit?: string | null): string
export declare function buildUpdateScript(options: {
    repoPath: string
    parentPid: number | string
    appName: string
    /**
     * Result of `checkUpdaterVersion`. When it says the library is behind, the
     * generated script says so and gives the command that actually moves it.
     */
    updater?: UpdaterVersion
    /** Offer the typed confirmation instead of refusing. Default false. */
    allowRisky?: boolean
    /** Phrase the script asks for. Default `REVIEWED`. */
    riskPhrase?: string
    /** Package manager to generate for. Detected from the checkout by default. */
    packageManager?: PackageManager
    /** Platform to generate for. Defaults to the running one. */
    platform?: NodeJS.Platform
}): string

/**
 * Absolute path to a bash able to run the update script, or null when there is
 * none. On Windows this is Git Bash — `/bin/bash` does not exist outside MSYS,
 * so a native Windows process cannot use it.
 */
export declare function resolveBashPath(): string | null

/** How a package manager is installed from, and how exposed its install is. */
export interface PackageManager {
    /** `npm`, `pnpm`, `yarn` or `bun`. */
    name: string
    /** The lockfile that identifies it, e.g. `pnpm-lock.yaml`. */
    lockfile: string
    /** Install command, e.g. `pnpm install`. */
    install: string
    /** Script-running prefix, e.g. `pnpm run`. */
    run: string
    /** Command that re-resolves a dependency's range, e.g. `pnpm update`. */
    update: string
    /**
     * Whether it runs a dependency's install scripts without approval. False
     * for pnpm 10+ and bun; true for npm 11 and earlier and yarn classic. It
     * decides how the gate words its warning, not whether the gate runs.
     */
    runsDependencyScripts: boolean
}

/**
 * The package manager a checkout uses: `packageManager` in package.json first,
 * then whichever lockfile is present, then npm.
 */
export declare function detectPackageManager(repoPath: string): PackageManager

/** The phrase the update script asks for before installing risky changes. */
export declare const RISK_CONFIRMATION: string

export declare const IPC_CHECK: string
export declare const IPC_APPLY: string
export declare const EVT_STATUS: string
