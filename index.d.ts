export type BannerMessageKey = 'available' | 'update' | 'updating' | 'upToDate';

export const DICT: Record<string, Record<BannerMessageKey, string>>;
export function translate(locale: string, key: BannerMessageKey | string): string;
