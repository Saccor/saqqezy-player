import type { VodKind } from './tabLogic.ts';

/** The user-visible strings and routes that differ between Movies and Series. Pure: no Solid, no Lightning. */
export interface KindCopy {
  empty: string;
  loadError: string;
  loading: string;
  detailRoute: 'movieDetail' | 'seriesDetail';
}

export const KIND_COPY: Record<VodKind, KindCopy> = {
  movie: {
    empty: 'This source has no movies.',
    loadError: 'Movies could not be loaded.',
    loading: 'Loading movies from your source…',
    detailRoute: 'movieDetail',
  },
  series: {
    empty: 'This source has no series.',
    loadError: 'Series could not be loaded.',
    loading: 'Loading series from your source…',
    detailRoute: 'seriesDetail',
  },
};
