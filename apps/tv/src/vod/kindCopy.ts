import { VOD_COPY } from '../copy.ts';
import type { VodKind } from './tabLogic.ts';

/** The user-visible strings and routes that differ between Movies and Series. Pure: no Solid, no Lightning. */
export interface KindCopy {
  empty: string;
  loadError: string;
  loading: string;
  detailRoute: 'movieDetail' | 'seriesDetail';
  /** The category picker's title on browse. */
  categoriesTitle: string;
}

export const KIND_COPY: Record<VodKind, KindCopy> = {
  movie: {
    empty: VOD_COPY.movies.empty,
    loadError: VOD_COPY.movies.loadError,
    loading: VOD_COPY.movies.loading,
    detailRoute: 'movieDetail',
    categoriesTitle: VOD_COPY.movies.categories,
  },
  series: {
    empty: VOD_COPY.series.empty,
    loadError: VOD_COPY.series.loadError,
    loading: VOD_COPY.series.loading,
    detailRoute: 'seriesDetail',
    categoriesTitle: VOD_COPY.series.categories,
  },
};

/** 12400 → "12,400" (no Intl: older TV engines). */
export function grouped(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Browse's catalogue status line (shown in the info strip): a first load still running (titles so far), else some categories missing, else
 * the cap. Empty when there is nothing to say.
 */
export function vodStatusLine(home: { progress?: number; partial?: boolean; truncated: boolean } | undefined): string {
  if (!home) return '';
  if (home.progress !== undefined) return VOD_COPY.loadingSoFar(grouped(home.progress));
  if (home.partial) return VOD_COPY.someCategoriesFailed;
  if (home.truncated) return VOD_COPY.truncated;
  return '';
}
