import type { BrowserWindow } from 'electron';

export interface UpdateStatus {
  available: boolean;
  behind: number;
  branch?: string;
  upstream?: string;
  reason?: string;
  error?: string;
  /** True when the incoming update changes install hooks or dependencies. */
  risky?: boolean;
  /** Human-readable list of the risky changes detected. */
  reasons?: string[];
}

export interface RiskReport {
  risky: boolean;
  reasons: string[];
}

export interface GitUpdaterOptions {
  /** Window to push status events to. */
  window?: BrowserWindow | null;
  /** Explicit source checkout path (auto-detected by default). */
  repoPath?: string | null;
  /** How often to re-check, in ms (default 1_800_000; 0 disables). */
  intervalMs?: number;
  /** Run an initial check shortly after launch (default true). */
  checkOnStart?: boolean;
  onError?: (message: string, error: unknown) => void;
}

export interface GitUpdaterHandle {
  check(): Promise<UpdateStatus>;
  stop(): void;
  repoPath: string;
}

export function initGitUpdater(options?: GitUpdaterOptions): GitUpdaterHandle;
export function checkForUpdates(repoPath: string): Promise<UpdateStatus>;
export function inspectIncomingRisk(repoPath: string): Promise<RiskReport>;
export function resolveRepoPath(explicit?: string | null): string;

export const IPC_CHECK: string;
export const IPC_APPLY: string;
export const EVT_STATUS: string;
