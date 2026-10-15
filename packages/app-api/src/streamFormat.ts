import type { AppSettings } from '@iptv/core';

export type StreamFormat = AppSettings['preferredFormat'];

/**
 * What played last on a source: `format`, while the preferred-format setting was `pref`. Device-local meta storage,
 * never synced; a format name only, no URL and no credentials (CLAUDE.md rule 7).
 */
export interface FormatMemo { format: StreamFormat; pref: StreamFormat }

export const formatMemoKey = (sourceId: string): string => `streamFormat:${sourceId}`;

export function formatOf(url: string): StreamFormat {
  return /\.m3u8(?:[?#]|$)/.test(url) ? 'm3u8' : 'ts';
}

export const isStreamFormat = (v: unknown): v is StreamFormat => v === 'ts' || v === 'm3u8';

export function isFormatMemo(v: unknown): v is FormatMemo {
  const m = v as Partial<FormatMemo> | null;
  return typeof m === 'object' && m !== null && isStreamFormat(m.format) && isStreamFormat(m.pref);
}

/** The format to try first: the one that played last on the source unless the setting changed since, else the setting. */
export function firstFormat(preferred: StreamFormat, memo: FormatMemo | undefined): StreamFormat {
  return memo !== undefined && memo.pref === preferred ? memo.format : preferred;
}
