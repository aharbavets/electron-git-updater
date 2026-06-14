import type { UpdateStatus } from './main';

export interface BannerApi {
  check(): Promise<UpdateStatus>;
  apply(): Promise<{ started: boolean; error?: string }>;
  onStatus(callback: (status: UpdateStatus) => void): () => void;
}

export type BannerMessageKey =
  | 'available'
  | 'availableManual'
  | 'update'
  | 'updating'
  | 'upToDate';

export interface BannerOptions {
  api?: BannerApi;
  /** BCP-47 locale for built-in strings (default navigator.language). */
  locale?: string;
  /** Explicit string overrides. */
  messages?: Partial<Record<BannerMessageKey, string>>;
}

export function mountUpdateBanner(opts?: BannerOptions): () => void;
