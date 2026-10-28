// Trending rows on Start (spec 2026-10-20-trending-design §6): where the public feed lives, and the About lines that
// credit its data sources. Pure, so the worker and the About page agree.

import { TRENDING_COPY } from '../copy.ts';

/** The fake provider's synthetic feed (tools/fake-xtream): the dev default, so the rows show on localhost. */
export const DEV_TRENDING_URL = 'http://127.0.0.1:8899/__trending';

export const TRENDING_ATTRIBUTION_TEXT = TRENDING_COPY.attribution;
/** Shown while the feed uses the free TMDB key (beta only): builds set VITE_TMDB_ATTRIBUTION=1. */
export const TMDB_ATTRIBUTION_TEXT = TRENDING_COPY.tmdb;

export interface TrendingEnv { VITE_TRENDING_URL?: string; VITE_TMDB_ATTRIBUTION?: string; DEV: boolean }

/** The feed base (no trailing slash), or undefined: no trending rows and no request. */
export function trendingBaseUrl(env: TrendingEnv): string | undefined {
  const raw = (env.VITE_TRENDING_URL ?? '').trim() || (env.DEV ? DEV_TRENDING_URL : '');
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return raw.replace(/\/+$/, '');
}

/** The About lines for this build. */
export function aboutAttribution(env: TrendingEnv): string[] {
  if (!trendingBaseUrl(env)) return [];
  return env.VITE_TMDB_ATTRIBUTION?.trim() === '1' ? [TRENDING_ATTRIBUTION_TEXT, TMDB_ATTRIBUTION_TEXT] : [TRENDING_ATTRIBUTION_TEXT];
}
