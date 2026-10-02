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
    onError?: (message: string, error: unknown) => void
}

export interface Updater {
    check(): Promise<UpdateStatus>
    repoPath: string
    stop(): void
}

export declare function initGitUpdater(options?: InitOptions): Updater
export declare function checkForUpdates(repoPath: string, buildCommit?: string): Promise<UpdateStatus>
export declare function inspectIncomingRisk(repoPath: string): Promise<{ risky: boolean; reasons: string[] }>
export declare function resolveRepoPath(explicit?: string | null): string
export declare function buildUpdateScript(options: {
    repoPath: string
    parentPid: number | string
    appName: string
    /** Platform to generate for. Defaults to the running one. */
    platform?: NodeJS.Platform
}): string

/**
 * Absolute path to a bash able to run the update script, or null when there is
 * none. On Windows this is Git Bash — `/bin/bash` does not exist outside MSYS,
 * so a native Windows process cannot use it.
 */
export declare function resolveBashPath(): string | null

export declare const IPC_CHECK: string
export declare const IPC_APPLY: string
export declare const EVT_STATUS: string
