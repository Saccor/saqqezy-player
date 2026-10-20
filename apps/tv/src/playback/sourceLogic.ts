import type { LiveSourceView, PlayableChannel } from '@iptv/app-api';
import type { OptionItem } from '../components/OptionsMenu.tsx';
import { TYPE } from '../shell/theme.ts';

/**
 * Combined live channels on the TV (spec 2026-10-20-live-sources-tv): the Choose source list, the guide cell's badge
 * and the info line. Pure.
 */

const hasWord = (text: string, word: string): boolean => text.toUpperCase().split(/[^A-Z0-9]+/).includes(word.toUpperCase());

/**
 * "Channel One · HD · Auto": the stream's name, its quality when the name does not already say it, then "Auto" for
 * the automatic pick (`i === 0`), "Playing" for the stream on screen and "Didn't play" for one tried last.
 */
export function sourceLabel(s: LiveSourceView, i: number, playingId: string | undefined): string {
  const parts = [s.label];
  if (s.quality && !hasWord(s.label, s.quality)) parts.push(s.quality);
  if (i === 0) parts.push('Auto');
  if (s.id === playingId) parts.push('Playing');
  else if (s.bad) parts.push("Didn't play");
  return parts.join(' · ');
}

/** One option per stream, best first; the id is the stream's channel id. */
export function sourceOptions(sources: readonly LiveSourceView[], playingId: string | undefined): OptionItem[] {
  return sources.map((s, i) => ({ id: s.id, label: sourceLabel(s, i, playingId) }));
}

/** The row a playable belongs to: a combined channel's row id, else its own id. */
export const rowIdOf = (ch: Pick<PlayableChannel, 'id' | 'rowId'> | undefined): string | undefined => ch && (ch.rowId ?? ch.id);

const combined = (n: number | undefined): n is number => n !== undefined && n > 1;

/** The guide cell's badge of a combined channel: its best quality ("4K"), else its stream count ("×3"); '' otherwise. */
export function cellBadge(quality: string | undefined, sources: number | undefined): string {
  if (!combined(sources)) return '';
  return quality ?? `×${sources}`;
}

/** The info block's addition for a combined channel: "4K · 3 sources", or "3 sources"; '' otherwise. */
export function sourcesLine(quality: string | undefined, sources: number | undefined): string {
  if (!combined(sources)) return '';
  return [quality, `${sources} sources`].filter(Boolean).join(' · ');
}

/**
 * Lightning measures text late, so the badge's width is estimated: 0.75 em a character at meta size (capitals and digits
 * run wider than the 0.6 em average); 0 without one.
 */
export function badgeWidth(text: string): number {
  return text === '' ? 0 : Math.ceil(text.length * 0.75 * TYPE.meta);
}
