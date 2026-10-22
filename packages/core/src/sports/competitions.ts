/**
 * The chips of Matches in your guide (design note §3.7): competition texts and category texts, both taken from the
 * user's own guide and ordered by its data. Pure.
 */
import { FOLLOWED_TEAM_LEN } from '../settings.ts';
import { categoryKey } from './match.ts';
import { competitionKey } from './rank.ts';
import { BROAD_SPORT_CATEGORIES, DVB_CODE, FOOTBALL_CATEGORIES } from './words.ts';

export const COMPETITION_CHIPS_MAX = 12;
export const CATEGORY_CHIPS_MAX = 6;
/** A competition is offered once it names this many events. */
const COMPETITION_MIN_EVENTS = 2;
/** View all shows this many competition chips per sport; the rest sit behind More…. */
export const COMPETITION_CHIPS_PER_SPORT = 8;
/** A competition seen only once still gets a chip when this many guide channels carry it (a one-off final). */
const WIDE_SINGLE_BREADTH = 4;

export { categoryKey };

/** `pinned`: the user put this competition first (View all's competition chips). */
export interface MatchChip { id: string; label: string; pinned?: true }
export interface MatchFilters { competitions: MatchChip[]; categories: MatchChip[] }

/**
 * `events`: grouped events with their competition text, breadth and folded categories. `labels`: folded category →
 * the guide's own spelling.
 */
export function matchFilters(
  events: readonly { comp?: string; breadth: number; cats: readonly string[] }[], labels: ReadonlyMap<string, string>,
): MatchFilters {
  const comps = new Map<string, { label: string; n: number; breadth: number }>();
  const cats = new Map<string, number>();
  for (const e of events) {
    if (e.comp !== undefined) {
      const k = competitionKey(e.comp);
      if (k) {
        const c = comps.get(k);
        if (c) { c.n++; c.breadth += e.breadth; } else comps.set(k, { label: e.comp.trim(), n: 1, breadth: e.breadth });
      }
    }
    for (const c of new Set(e.cats)) {
      // Longer texts would be cut when stored, and a cut id never matches again.
      if (BROAD_SPORT_CATEGORIES.has(c) || DVB_CODE.test(c) || !labels.has(c) || c.length > FOLLOWED_TEAM_LEN) continue;
      cats.set(c, (cats.get(c) ?? 0) + 1);
    }
  }
  const competitions = [...comps].filter(([, c]) => c.n >= COMPETITION_MIN_EVENTS)
    .sort((a, b) => b[1].breadth - a[1].breadth || b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .slice(0, COMPETITION_CHIPS_MAX).map(([id, c]) => ({ id, label: c.label }));
  const categories = [...cats]
    .sort((a, b) => Number(FOOTBALL_CATEGORIES.has(b[0])) - Number(FOOTBALL_CATEGORIES.has(a[0])) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, CATEGORY_CHIPS_MAX).map(([id]) => ({ id, label: labels.get(id)! }));
  return { competitions, categories };
}

/**
 * View all's second chip row (spec 2026-10-22 §3.2): the competitions of events that carry `category`, as the guide
 * writes them. Pinned first (marked), then by summed breadth, event count and key. Hidden ones are left out. A
 * competition needs 2 events, or 1 carried by WIDE_SINGLE_BREADTH channels, unless pinned. Pure.
 */
export function competitionChips(
  events: readonly { comp?: string; breadth: number; cats: readonly string[] }[],
  category: string,
  o: { pinned: readonly string[]; hidden: readonly string[]; max?: number },
): { chips: MatchChip[]; more: MatchChip[] } {
  const hidden = new Set(o.hidden);
  const pinned = new Set(o.pinned);
  const comps = new Map<string, { label: string; n: number; breadth: number; top: number }>();
  for (const e of events) {
    if (e.comp === undefined || !e.cats.includes(category)) continue;
    const k = competitionKey(e.comp);
    if (!k || hidden.has(k)) continue;
    const c = comps.get(k);
    if (c) { c.n++; c.breadth += e.breadth; c.top = Math.max(c.top, e.breadth); } else comps.set(k, { label: e.comp.trim(), n: 1, breadth: e.breadth, top: e.breadth });
  }
  const all = [...comps]
    .filter(([k, c]) => c.n >= COMPETITION_MIN_EVENTS || c.top >= WIDE_SINGLE_BREADTH || pinned.has(k))
    .sort((a, b) => Number(pinned.has(b[0])) - Number(pinned.has(a[0])) || b[1].breadth - a[1].breadth || b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .map(([id, c]): MatchChip => (pinned.has(id) ? { id, label: c.label, pinned: true } : { id, label: c.label }));
  const max = o.max ?? COMPETITION_CHIPS_PER_SPORT;
  return { chips: all.slice(0, max), more: all.slice(max) };
}
