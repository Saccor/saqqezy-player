import type { EpisodeView, SeasonView, SeriesPrimary, SeriesView } from '@iptv/app-api';
import { episodeLabel } from '@iptv/core';
import { seriesMetaLine } from './heroLogic.ts';
import { formatRuntime } from './posterLogic.ts';

/** Series detail screen decisions. Pure: no Solid, no Lightning. */

/** The primary button label: "Continue S2 · E4", "Play S1 · E1", or "Play" before the view has loaded. */
export function primaryLabel(p: SeriesPrimary | undefined): string {
  if (!p) return 'Play';
  const label = episodeLabel(p.season, p.episode);
  return p.mode === 'continue' ? `Continue ${label}` : `Play ${label}`;
}

/** Season index and episode index to open on: the season holding `primary`, that episode; else 0/0. */
export function initialFocus(view: SeriesView): { season: number; episode: number } {
  const p = view.primary;
  if (!p) return { season: 0, episode: 0 };
  const season = view.seasons.findIndex((s) => s.episodes.some((e) => e.id === p.episodeId));
  if (season < 0) return { season: 0, episode: 0 };
  const episode = view.seasons[season]!.episodes.findIndex((e) => e.id === p.episodeId);
  return { season, episode: Math.max(0, episode) };
}

/** "E4 · 42 min" (runtime omitted when unknown). */
export function episodeMeta(e: EpisodeView): string {
  const rt = formatRuntime(e.runtimeMin);
  const label = `E${e.episode}`;
  return rt ? `${label} · ${rt}` : label;
}

/** The season tab label: the season's name when it is not just a number, else "Season N"; number 0 is "Specials". */
export function seasonLabel(s: SeasonView): string {
  if (s.number === 0) return 'Specials';
  const name = s.name.trim();
  if (name === '' || /^\d+$/.test(name)) return `Season ${s.number}`;
  return name;
}

/** Regular seasons only: Specials (number 0) do not count as a season. */
export function regularSeasonCount(seasons: readonly SeasonView[]): number {
  return seasons.filter((s) => s.number > 0).length;
}

/** Hero meta: "2021 · 3 seasons · Drama · 12 · ★ 7.9" from the parts that exist. */
export function seriesMeta(view: SeriesView): string {
  const d = view.detail;
  return seriesMetaLine({
    year: view.tile.year,
    seasons: regularSeasonCount(view.seasons),
    genre: d?.genre,
    ageRating: d?.ageRating,
    rating: view.tile.rating,
  });
}

/** After returning from the player: keep the focused episode by id when it still exists, else the same season at its first episode, else 0/0. */
export function refocus(
  prev: { seasonNumber: number; episodeId: string } | undefined,
  view: SeriesView,
): { season: number; episode: number } {
  if (!prev) return initialFocus(view);
  const byId = view.seasons.findIndex((s) => s.episodes.some((e) => e.id === prev.episodeId));
  if (byId >= 0) {
    return { season: byId, episode: view.seasons[byId]!.episodes.findIndex((e) => e.id === prev.episodeId) };
  }
  const sIdx = view.seasons.findIndex((s) => s.number === prev.seasonNumber);
  return { season: Math.max(0, sIdx), episode: 0 };
}

/** A season tab's width from its label: roughly the text plus padding, kept between 140 and 360. */
export function seasonTabWidth(label: string): number {
  return Math.max(140, Math.min(360, Math.round(label.length * 13) + 56));
}

/** Left edges of tabs laid out left to right with `gap` between them. */
export function stripStarts(widths: readonly number[], gap: number): number[] {
  let x = 0;
  return widths.map((w) => { const at = x; x += w + gap; return at; });
}

/** The tab under a strip-local x (scroll already added), undefined in a gap or outside. */
export function stripAt(starts: readonly number[], widths: readonly number[], x: number): number | undefined {
  const i = starts.findIndex((s, k) => x >= s && x < s + widths[k]!);
  return i >= 0 ? i : undefined;
}

/** The strip's scroll offset keeping the focused tab fully in a `view`-wide window, moving as little as possible. */
export function stripOffset(starts: readonly number[], widths: readonly number[], focus: number, view: number, prev: number): number {
  const n = starts.length;
  if (n === 0) return 0;
  const total = starts[n - 1]! + widths[n - 1]!;
  const i = Math.max(0, Math.min(focus, n - 1));
  let next = prev;
  if (starts[i]! < next) next = starts[i]!;
  else if (starts[i]! + widths[i]! > next + view) next = starts[i]! + widths[i]! - view;
  return Math.max(0, Math.min(next, Math.max(0, total - view)));
}

/** The card under a row-local x for a row scrolled to `scroll` cards, undefined in a gap or past the last card. */
export function cardAt(px: number, scroll: number, pitch: number, cardW: number, total: number): number | undefined {
  if (px < 0) return undefined;
  const c = scroll + Math.floor(px / pitch);
  return px % pitch < cardW && c < total ? c : undefined;
}

/** The series detail's focus areas, top to bottom. */
export type SeriesArea = 'actions' | 'seasons' | 'episodes';
/** Where the screen was, kept in its router params so a remount (returning from the player) lands there again. */
export interface SavedFocus { seasonNumber: number; episodeId: string }

/**
 * The first load after a (re)mount: the saved episode and area when the screen was left from the seasons or episodes
 * (returning from the player); else the primary episode (it may have moved on) with focus on the primary button.
 * When the saved episode is now watched (the player auto-advanced past it) and there is a primary, the primary's
 * episode is focused instead, in the same area.
 */
export function remountRestore(
  saved: { focus?: SavedFocus; area?: SeriesArea },
  view: SeriesView,
): { prev: SavedFocus | undefined; area: SeriesArea } {
  if (!saved.focus || (saved.area !== 'seasons' && saved.area !== 'episodes')) return { prev: undefined, area: 'actions' };
  const id = saved.focus.episodeId;
  const watched = view.seasons.some((s) => s.episodes.some((e) => e.id === id && e.watched));
  const p = view.primary;
  if (watched && p) return { prev: { seasonNumber: p.season, episodeId: p.episodeId }, area: saved.area };
  return { prev: saved.focus, area: saved.area };
}

/** The area to focus when `a` may have emptied: episodes fall back to the seasons, no seasons to the actions. */
export function fallbackArea(a: SeriesArea, counts: { seasons: number; episodes: number }): SeriesArea {
  if (a === 'episodes' && counts.episodes === 0) a = 'seasons';
  if (a === 'seasons' && counts.seasons === 0) a = 'actions';
  return a;
}

/** The season tab selection after a reload: the placed season, except while the keys are on the tabs (kept, clamped). */
export function tabSelAfterReload(area: SeriesArea, tabSel: number, placedSeason: number, seasons: number): number {
  if (area !== 'seasons') return placedSeason;
  return Math.max(0, Math.min(tabSel, seasons - 1));
}

/** The action buttons: the primary episode (hidden once loaded without one) and Favourite. */
export function seriesActions(p: { loaded: boolean; primary?: SeriesPrimary; favourite: boolean }): { id: string; label: string; width: number }[] {
  const fav = { id: 'fav', label: p.favourite ? 'In favourites' : 'Add to favourites', width: 320 };
  if (p.loaded && !p.primary) return [fav];
  return [{ id: 'play', label: primaryLabel(p.primary), width: p.primary ? 360 : 220 }, fav];
}
