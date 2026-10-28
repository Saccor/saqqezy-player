/**
 * Movies or Series browse's strip and backdrop for the dwelled title: its detail (plot, runtime or seasons, backdrop)
 * read once focus rests (the dwell is the debounce), the meta line, and the art that cross-fades from the last one.
 * Create it inside the screen component: its effect and memo belong to the screen. Not unit-tested: the pure rules
 * live in heroLogic.ts, fadeLogic.ts and stripLogic.ts.
 */
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import type { MovieView, SeriesView } from '@iptv/app-api';
import { api } from '../../api.ts';
import { posterCache } from '../../components/posterCache.ts';
import { heroArt } from '../../vod/fadeLogic.ts';
import { seriesMetaLine } from '../../vod/heroLogic.ts';
import { metaLine } from '../../vod/posterLogic.ts';
import { regularSeasonCount } from '../../vod/seriesDetailLogic.ts';
import { joinMeta, tileStatus } from '../../vod/stripLogic.ts';
import type { BrowseState } from './createBrowseState.ts';

export function createBrowseHero(st: BrowseState, alive: () => boolean) {
  const { kind, hero, setHero, stripTile } = st;
  // The strip's detail (plot, runtime or seasons, backdrop) for the dwelled title; the tile's own fields show at once.
  /** A title whose detail could not be read: its art is settled as none (it is no longer pending). */
  const [heroMissId, setHeroMissId] = createSignal<string | undefined>(undefined);
  const loadHero = (id: string) => {
    const view: Promise<MovieView | SeriesView | undefined> = kind === 'series' ? api.getSeries(id) : api.getMovie(id);
    const missed = () => { if (alive() && stripTile()?.id === id) setHeroMissId(id); };
    void view.then((v) => {
      if (!alive() || stripTile()?.id !== id) return;
      setHero(v);
      if (!v) missed();
    }).catch(missed);
  };
  /** Drops a detail that belongs to another title and loads the dwelled tile's (the dwell is the debounce). */
  const syncHero = () => {
    const t = stripTile();
    if (hero()?.tile.id !== t?.id) setHero(undefined);
    if (t && hero()?.tile.id !== t.id) loadHero(t.id);
  };
  createEffect(on(stripTile, () => syncHero()));

  /** The focused series' view once loaded (its primary episode and seasons). */
  const heroSeries = (): SeriesView | undefined => {
    const h = hero();
    return kind === 'series' && h && h.tile.id === stripTile()?.id ? (h as SeriesView) : undefined;
  };
  /** The detail only shows while it belongs to the strip's title. */
  const heroDetail = () => (hero()?.tile.id === stripTile()?.id ? hero()?.detail : undefined);
  const art = () => heroDetail()?.backdrop ?? undefined;
  const backdropUrl = () => {
    const u = art();
    return u && posterCache.usable(u) ? u : undefined;
  };
  /** The strip title's detail is still on its way (neither loaded nor known missing). */
  const heroPending = () => {
    const t = stripTile();
    return t !== undefined && hero()?.tile.id !== t.id && heroMissId() !== t.id;
  };
  /** The art drawn: the last one stays while the next title is pending, so the new art cross-fades over it. */
  const shownArt = createMemo<string | undefined>((prev) => heroArt(prev, heroPending(), backdropUrl()));
  /** "2022 · 1 h 54 min · Drama · 12 · ★ 7.6"; a series shows "N seasons" in place of the runtime once its view is loaded. */
  const heroMeta = () => {
    const d = heroDetail();
    const t = stripTile();
    if (kind !== 'series') {
      const runtimeMin = (d as MovieView['detail'] | undefined)?.runtimeMin;
      return metaLine({ year: t?.year, runtimeMin, genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
    }
    return seriesMetaLine({ year: t?.year, seasons: regularSeasonCount(heroSeries()?.seasons ?? []), genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
  };
  const stripMeta = () => joinMeta(heroMeta(), stripTile() ? tileStatus(stripTile()!) : '');

  return { syncHero, heroDetail, shownArt, stripMeta };
}
