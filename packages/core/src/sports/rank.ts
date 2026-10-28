/**
 * Matches in your guide: which grouped events show, and in what order (design note live-matches-ranking §3.5–3.6,
 * owner decisions 2026-10-20). Pure; O(E log E) per call. Every signal comes from the user's own guide and settings.
 */
import { foldText } from '../text/fold.ts';

const M = 60_000;
const H = 60 * M;
export const MATCHES_ROW_CAP = 12;
export const MATCHES_ALL_CAP = 100;
/** The window widening aims for at least this many matches (it never pads the row). */
export const MATCHES_MIN = 4;
/** Upcoming window steps (hours): the first that holds MATCHES_MIN matches, else the last. */
export const MATCH_WINDOWS_H = [6, 12, 24] as const;
/** Followed sides are looked up this far ahead (the raw index window). */
export const FOLLOWED_AHEAD_MS = 36 * H;
/** The Start row (On now): on air, or kick-off within this long; never widened (spec 2026-10-24 §1.2). */
export const ON_NOW_AHEAD_MS = 2 * H;
/** On air counts only for events that started at most this long ago. */
const ON_AIR_BACK_MS = 3 * H;
/** Shorter slots need a live marker (highlights shows are often 45–50 min). */
const MIN_LEN_MS = 60 * M;
/** G8: a row match needs at least this share of the top breadth (multi-country guides and guides with no country prefix). */
const FOCUS_SHARE = 0.25;

/**
 * What the channel names say about countries: `one` prefix seen, `many`, or `unknown` (no prefix at all). `one` turns
 * the G8 size cut-off off; `unknown` uses the same 25 % share as `many` but accepts a single channel.
 */
export type CountryScope = 'one' | 'many' | 'unknown';

export interface MatchEvent {
  title: string; start: number; stop: number;
  /** Two sides after side parsing; undefined for a title-only event (golf, cycling, a studio show). */
  sides?: [string, string];
  /** Competition text from the guide, as written. */
  comp?: string;
  /** Folded category texts of its airings. */
  cats: readonly string[];
  /** A sport category or DVB sport code on one of its airings. */
  sportCat: boolean;
  /** Its sides were split on a strong separator (v, vs, gegen, mot). */
  strong: boolean;
  /** Live-marked in the guide (`<live/>`, a live prefix or suffix). */
  liveMark: boolean;
  /** Airs on a guide channel with several sport programmes. */
  sporty: boolean;
  /** Distinct guide channels (fold rows when combining) among the user's visible channels. */
  breadth: number;
  /** Distinct guide channels on a chosen-country channel (0 until countries are chosen). */
  countryBreadth: number;
  followed: boolean;
  /** A later airing of a pair that already aired (gate G3). */
  reair: boolean;
}

export interface RankOptions {
  now: number;
  /** Folded competition keys (`competitionKey`). */
  pinned: readonly string[];
  hidden: readonly string[];
  /** Folded category texts; empty: every category. */
  categories: readonly string[];
  /** G8 cut-off: `one` → 1, `unknown` → max(1, ceil(0.25 × top)), `many` → max(2, ceil(0.25 × top)). */
  countryScope: CountryScope;
}

export interface RankedMatch<E> { event: E; score: number; onAir: boolean; match: boolean }
export interface RankedMatches<E> {
  /** The Start row (On now): the focus set on air, then kick-offs within ON_NOW_AHEAD_MS; capped at MATCHES_ROW_CAP. */
  row: RankedMatch<E>[];
  /** See all: every passing match, then non-match sport, capped at MATCHES_ALL_CAP. */
  all: RankedMatch<E>[];
  /** Everything that passed, before the See all cap (the View all count). */
  total: number;
  windowHours: number;
}

/** The stored and compared form of a competition text. */
export function competitionKey(text: string): string {
  return foldText(text.trim()).replace(/\s+/g, ' ');
}

const onAirAt = (e: { start: number; stop: number }, now: number) => e.start <= now && now < e.stop && e.start >= now - ON_AIR_BACK_MS;

/** score = 1e6·F + 1e5·P + 1e4·B + 1e3·K + 1e2·L + 10·M + R (design note §3.6). */
export function matchScore(e: MatchEvent, now: number, pinned: ReadonlySet<string>): number {
  const f = e.followed ? 1 : 0;
  const p = e.comp !== undefined && pinned.has(competitionKey(e.comp)) ? 1 : 0;
  const b = Math.min(5, Math.floor(Math.log2(Math.max(1, e.breadth))));
  const k = Math.min(3, Math.floor(Math.log2(1 + Math.max(0, e.countryBreadth))));
  const live = onAirAt(e, now);
  const l = live ? 1 : 0;
  const m = e.liveMark ? 1 : 0;
  const r = live ? 9 : 9 - Math.min(9, Math.floor(Math.max(0, e.start - now) / (40 * M)));
  return 1e6 * f + 1e5 * p + 1e4 * b + 1e3 * k + 1e2 * l + 10 * m + r;
}

/** G2: a sport signal from the guide. A weak separator always needs a category or a sports channel. */
function sportSignal(e: MatchEvent): boolean {
  if (e.sportCat) return true;
  if (!e.strong) return e.sporty;
  return (e.liveMark && e.sporty) || e.breadth >= 2;
}

export function rankMatches<E extends MatchEvent>(events: readonly E[], o: RankOptions): RankedMatches<E> {
  const { now } = o;
  const hidden = new Set(o.hidden);
  const pinned = new Set(o.pinned);
  const cats = new Set(o.categories);
  const matches: RankedMatch<E>[] = [];
  const others: RankedMatch<E>[] = [];
  for (const e of events) {
    if (e.reair) continue; // G3
    if (e.stop - e.start < MIN_LEN_MS && !e.liveMark) continue; // G5
    if (e.comp !== undefined && hidden.size && hidden.has(competitionKey(e.comp))) continue; // G7
    if (cats.size && !e.cats.some((c) => cats.has(c))) continue;
    const onAir = onAirAt(e, now);
    if (!onAir && e.start <= now) continue; // G6: ended, or started too long ago
    if (!e.followed && e.start > now + MATCH_WINDOWS_H[MATCH_WINDOWS_H.length - 1]! * H) continue;
    if (e.start > now + FOLLOWED_AHEAD_MS) continue;
    if (e.sides) {
      if (sportSignal(e)) matches.push({ event: e, score: 0, onAir, match: true }); // G1, G2
    } else if (e.sportCat) {
      others.push({ event: e, score: 0, onAir, match: false });
    }
  }

  // G6: the narrowest window that holds MATCHES_MIN matches (followed ones further ahead always count).
  let windowHours: number = MATCH_WINDOWS_H[MATCH_WINDOWS_H.length - 1]!;
  for (const w of MATCH_WINDOWS_H) {
    const end = now + w * H;
    let c = 0;
    for (const m of matches) if (m.onAir || m.event.start <= end) c++;
    if (c >= MATCHES_MIN) { windowHours = w; break; }
  }
  const end = now + windowHours * H;
  const inWindow = (m: RankedMatch<E>) => m.onAir || m.event.start <= end || (m.event.followed && m.event.start <= now + FOLLOWED_AHEAD_MS);
  const ms = matches.filter(inWindow);
  const os = others.filter((m) => m.onAir || m.event.start <= end);

  for (const m of ms) m.score = matchScore(m.event, now, pinned);
  ms.sort((a, b) => b.score - a.score || a.event.start - b.event.start || (a.event.title < b.event.title ? -1 : a.event.title > b.event.title ? 1 : 0));
  os.sort((a, b) => Number(b.onAir) - Number(a.onAir) || a.event.start - b.event.start || (a.event.title < b.event.title ? -1 : 1));

  // G8: the row keeps only the broadly carried matches, plus followed, pinned and chosen-country ones. It is never
  // padded: a short row is better than small matches (owner decision 2026-10-22); they stay in See all.
  // The cut-off is measured only among the row's own candidates (on air, or kicking off within ON_NOW_AHEAD_MS), so a
  // far-off big match in the widened See-all window never hides a smaller live match.
  let top = 0;
  for (const m of ms) if ((m.onAir || m.event.start <= now + ON_NOW_AHEAD_MS) && m.event.breadth > top) top = m.event.breadth;
  const cut = o.countryScope === 'one' ? 1
    : o.countryScope === 'unknown' ? Math.max(1, Math.ceil(FOCUS_SHARE * top))
    : Math.max(2, Math.ceil(FOCUS_SHARE * top));
  const focus = ms.filter(({ event: e }) => e.breadth >= cut || e.followed || e.countryBreadth > 0
    || (e.comp !== undefined && pinned.has(competitionKey(e.comp))));

  // On now (spec 2026-10-24 §1.2): on air first in score order, then kick-offs within ON_NOW_AHEAD_MS by start.
  // No widening and no followed exception: the row is what plays now; the rest stays in See all.
  const rowEnd = now + ON_NOW_AHEAD_MS;
  const live = focus.filter((m) => m.onAir);
  const next = focus.filter((m) => !m.onAir && m.event.start <= rowEnd)
    .sort((a, b) => a.event.start - b.event.start || b.score - a.score || (a.event.title < b.event.title ? -1 : a.event.title > b.event.title ? 1 : 0));
  const row = [...live, ...next];

  const all = [...ms, ...os];
  return { row: row.slice(0, MATCHES_ROW_CAP), all: all.slice(0, MATCHES_ALL_CAP), total: all.length, windowHours };
}
