import type { Episode, Season, SeriesPointer, VodUserRecord, VodUserState } from './types.ts';

export const WATCHED_RATIO = 0.92;
export const MIN_RESUME_MS = 60_000;
export const CONTINUE_MAX = 20;

export interface SeriesContinue { seriesId: string; episodeId: string; season: number; episode: number; resumeMs: number }

export const emptyUserState = (): VodUserState => ({ position: 0, duration: 0, watched: false, favourite: false, updatedAt: 0 });

export const isInProgress = (s: VodUserState): boolean => !s.watched && s.position >= MIN_RESUME_MS;

export const resumeMs = (s: VodUserState | undefined): number => (s && isInProgress(s) ? s.position : 0);

/**
 * A progress save. Reaching `WATCHED_RATIO` marks watched and clears the position. Playing past `MIN_RESUME_MS`
 * of a watched title counts as re-watching (watched clears); a shorter scrub keeps it watched.
 */
export function applyProgress(
  prev: VodUserState | undefined, positionMs: number, durationMs: number, now: number, series?: SeriesPointer,
): VodUserState {
  const s: VodUserState = { ...(prev ?? emptyUserState()), updatedAt: now };
  if (durationMs > 0) s.duration = durationMs;
  if (series) s.series = series;
  const pos = Math.max(0, positionMs);
  if (s.duration > 0 && pos / s.duration >= WATCHED_RATIO) {
    s.watched = true;
    s.position = 0;
  } else if (pos >= MIN_RESUME_MS) {
    s.watched = false;
    s.position = pos;
  } else {
    s.position = s.watched ? 0 : pos;
  }
  return s;
}

/**
 * Mark as watched or unwatched; both clear the position. Watched bumps `updatedAt` (an episode marked watched
 * becomes its series' latest record, so Continue watching moves to `series.next`). Unwatched keeps `updatedAt`:
 * it never becomes the latest record, so a series' Continue state is untouched (an unwatched movie has no
 * position, so it is not in Continue watching either way).
 */
export function setWatched(prev: VodUserState | undefined, on: boolean, now: number, series?: SeriesPointer): VodUserState {
  const base = prev ?? emptyUserState();
  const s: VodUserState = { ...base, watched: on, position: 0, updatedAt: on ? now : base.updatedAt };
  if (series) s.series = series;
  return s;
}

/** "Remove from Continue watching": drops the position and the next-episode pointer, keeps watched. */
export function clearProgress(prev: VodUserState | undefined): VodUserState {
  const s: VodUserState = { ...(prev ?? emptyUserState()), position: 0 };
  if (s.series) {
    const { next: _next, ...rest } = s.series;
    s.series = rest;
  }
  return s;
}

export function setFavourite(prev: VodUserState | undefined, on: boolean): VodUserState {
  return { ...(prev ?? emptyUserState()), favourite: on };
}

export function setTracks(prev: VodUserState | undefined, tracks: { audio?: string; subtitle?: string }): VodUserState {
  return { ...(prev ?? emptyUserState()), ...tracks };
}

/** Movie ids in progress, newest first. Episode records (with a series pointer) are left out. */
export function continueMovies(records: VodUserRecord[], max = CONTINUE_MAX): string[] {
  return records
    .filter((r) => !r.state.series && isInProgress(r.state))
    .sort((a, b) => b.state.updatedAt - a.state.updatedAt)
    .slice(0, max)
    .map((r) => r.itemId);
}

/** Per series, its most recently updated episode: resume it if in progress, else its known next episode. */
export function continueSeries(records: VodUserRecord[], max = CONTINUE_MAX): SeriesContinue[] {
  const latest = new Map<string, VodUserRecord>();
  for (const r of records) {
    const p = r.state.series;
    if (!p) continue;
    const cur = latest.get(p.id);
    if (!cur || r.state.updatedAt > cur.state.updatedAt) latest.set(p.id, r);
  }
  const out: (SeriesContinue & { at: number })[] = [];
  for (const r of latest.values()) {
    const p = r.state.series!;
    if (isInProgress(r.state)) {
      out.push({ seriesId: p.id, episodeId: r.itemId, season: p.season, episode: p.episode, resumeMs: r.state.position, at: r.state.updatedAt });
    } else if (r.state.watched && p.next) {
      out.push({ seriesId: p.id, episodeId: p.next.id, season: p.next.season, episode: p.next.episode, resumeMs: 0, at: r.state.updatedAt });
    }
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map(({ at: _at, ...rest }) => rest);
}

/** The episode after `episodeId` in season order. A regular season's finale is the end: Specials (season 0) never follow it. */
export function nextEpisode(seasons: Season[], episodeId: string): Episode | undefined {
  for (let s = 0; s < seasons.length; s++) {
    const season = seasons[s]!;
    const i = season.episodes.findIndex((e) => e.id === episodeId);
    if (i < 0) continue;
    if (i + 1 < season.episodes.length) return season.episodes[i + 1];
    const after = seasons[s + 1];
    if (!after || (after.number === 0 && season.number !== 0)) return undefined;
    return after.episodes[0];
  }
  return undefined;
}

/** The episode before `episodeId`: the previous one in its season, else the last of the previous season (never between Specials and a regular season). */
export function prevEpisode(seasons: Season[], episodeId: string): Episode | undefined {
  for (let s = 0; s < seasons.length; s++) {
    const season = seasons[s]!;
    const i = season.episodes.findIndex((e) => e.id === episodeId);
    if (i < 0) continue;
    if (i > 0) return season.episodes[i - 1];
    const before = seasons[s - 1];
    if (!before || (before.number === 0) !== (season.number === 0)) return undefined;
    return before.episodes[before.episodes.length - 1];
  }
  return undefined;
}

export const episodeLabel = (season: number, episode: number): string => `S${season} · E${episode}`;
