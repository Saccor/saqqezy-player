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

/** Hero meta: "2021 · 3 seasons · Drama · 12 · ★ 7.9" from the parts that exist. */
export function seriesMeta(view: SeriesView): string {
  const d = view.detail;
  return seriesMetaLine({
    year: view.tile.year,
    seasons: view.seasons.length,
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
