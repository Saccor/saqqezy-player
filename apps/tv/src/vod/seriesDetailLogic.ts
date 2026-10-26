import type { EpisodeView, SeasonView, SeriesPrimary, SeriesView } from '@iptv/app-api';
import { episodeLabel } from '@iptv/core';
import { FAV_COPY, VOD_COPY } from '../copy.ts';
import { seriesMetaLine } from './heroLogic.ts';
import { formatRuntime } from './posterLogic.ts';

/** Series detail screen decisions. Pure: no Solid, no Lightning. */

/** The primary button label: "Continue S2 · E4", "Play S1 · E1", or "Play" before the view has loaded. */
export function primaryLabel(p: SeriesPrimary | undefined): string {
  if (!p) return VOD_COPY.play;
  const label = episodeLabel(p.season, p.episode);
  return p.mode === 'continue' ? VOD_COPY.continueEpisode(label) : VOD_COPY.playEpisode(label);
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
  const label = VOD_COPY.episode(e.episode);
  return rt ? `${label} · ${rt}` : label;
}

/** The season dropdown label and list row label: the season's name when it is not just a number, else "Season N"; number 0 is "Specials". */
export function seasonLabel(s: SeasonView): string {
  if (s.number === 0) return VOD_COPY.specials;
  const name = s.name.trim();
  if (name === '' || /^\d+$/.test(name)) return VOD_COPY.seasonNumber(s.number);
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

/** The card under a row-local x for a row scrolled to `scroll` cards, undefined in a gap or past the last card. */
export function cardAt(px: number, scroll: number, pitch: number, cardW: number, total: number): number | undefined {
  if (px < 0) return undefined;
  const c = scroll + Math.floor(px / pitch);
  return px % pitch < cardW && c < total ? c : undefined;
}

/** The series detail's focus areas, top to bottom. */
export type SeriesArea = 'actions' | 'season' | 'episodes';
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
  if (!saved.focus || (saved.area !== 'season' && saved.area !== 'episodes')) return { prev: undefined, area: 'actions' };
  const id = saved.focus.episodeId;
  const watched = view.seasons.some((s) => s.episodes.some((e) => e.id === id && e.watched));
  const p = view.primary;
  if (watched && p) return { prev: { seasonNumber: p.season, episodeId: p.episodeId }, area: saved.area };
  return { prev: saved.focus, area: saved.area };
}

/** The area Up or Down moves to from `a`: one step through actions, season, episodes; an empty area is skipped (stays put). */
export function moveArea(a: SeriesArea, key: 'up' | 'down', counts: { seasons: number; episodes: number }): SeriesArea {
  const order: SeriesArea[] = ['actions', 'season', 'episodes'];
  const want = order[Math.max(0, Math.min(2, order.indexOf(a) + (key === 'down' ? 1 : -1)))]!;
  const live = fallbackArea(want, counts);
  return live === want ? want : a;
}

/** The area to focus when `a` may have emptied: episodes fall back to the seasons, no seasons to the actions. */
export function fallbackArea(a: SeriesArea, counts: { seasons: number; episodes: number }): SeriesArea {
  if (a === 'episodes' && counts.episodes === 0) a = 'season';
  if (a === 'season' && counts.seasons === 0) a = 'actions';
  return a;
}

/** A series action: the primary episode button, or Favourite (a round heart; the screen sizes it). */
export type SeriesAction = { id: 'play'; label: string; width: number } | { id: 'fav'; label: string };

/** The action buttons: the primary episode (hidden once loaded without one) and Favourite. */
export function seriesActions(p: { loaded: boolean; primary?: SeriesPrimary; favourite: boolean }): SeriesAction[] {
  const fav: SeriesAction = { id: 'fav', label: p.favourite ? FAV_COPY.in : FAV_COPY.add };
  if (p.loaded && !p.primary) return [fav];
  return [{ id: 'play', label: primaryLabel(p.primary), width: p.primary ? 360 : 220 }, fav];
}

/**
 * Where the first load's restore moves focus (the saved seasons or episodes area), or undefined to leave it: focus
 * starts on the actions, and once the user has pressed a key (a Favourite press while loading) the restore only places
 * the season and episode.
 */
export function restoreFocusMove(area: SeriesArea | undefined, userPressed: boolean): SeriesArea | undefined {
  return area !== undefined && area !== 'actions' && !userPressed ? area : undefined;
}
