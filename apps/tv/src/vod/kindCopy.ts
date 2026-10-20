import type { VodKind } from './tabLogic.ts';

/** The user-visible strings and routes that differ between Movies and Series. Pure: no Solid, no Lightning. */
export interface KindCopy {
  empty: string;
  loadError: string;
  loading: string;
  detailRoute: 'movieDetail' | 'seriesDetail';
  /** The grid's All entry, in running text ("Green: all movies"). */
  allLabel: string;
  /** The category picker's title on browse. */
  categoriesTitle: string;
}

export const KIND_COPY: Record<VodKind, KindCopy> = {
  movie: {
    empty: 'This source has no movies.',
    loadError: 'Movies could not be loaded.',
    loading: 'Loading movies from your source…',
    detailRoute: 'movieDetail',
    allLabel: 'all movies',
    categoriesTitle: 'Movie categories',
  },
  series: {
    empty: 'This source has no series.',
    loadError: 'Series could not be loaded.',
    loading: 'Loading series from your source…',
    detailRoute: 'seriesDetail',
    allLabel: 'all series',
    categoriesTitle: 'Series categories',
  },
};

/** 12400 → "12,400" (no Intl: older TV engines). */
export function grouped(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The one line under the tab bar: a first load still running (titles so far), else some categories missing, else
 * the cap. Empty when there is nothing to say.
 */
export function vodStatusLine(kind: VodKind, home: { progress?: number; partial?: boolean; truncated: boolean } | undefined): string {
  if (!home) return '';
  if (home.progress !== undefined) return `Still loading… ${grouped(home.progress)} ${kind === 'movie' ? 'movies' : 'series'} so far`;
  if (home.partial) return 'Some categories could not be loaded.';
  if (home.truncated) return 'Showing the first 200,000 titles.';
  return '';
}
