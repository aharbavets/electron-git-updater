import type { UpdateStatus } from "./main"

export interface GitUpdaterBridge {
    /** Force an immediate check. */
    check(): Promise<UpdateStatus>
    /** Start the update — a Terminal opens and the app quits. */
    apply(): Promise<
        | { started: true }
        | { started: false; blocked?: boolean; reasons?: string[]; error?: string }
    >
    /** Subscribe to periodic status pushes; returns an unsubscribe function. */
    onStatus(callback: (status: UpdateStatus) => void): () => void
}

/** Expose the bridge on window[key] (default 'gitUpdater'). */
export declare function exposeGitUpdater(key?: string): void
