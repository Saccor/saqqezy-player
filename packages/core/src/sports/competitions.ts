/**
 * The chips of Matches in your guide (design note §3.7): competition texts and category texts, both taken from the
 * user's own guide and ordered by its data. Pure.
 */
import { competitionKey } from './rank.ts';
import { BROAD_SPORT_CATEGORIES, DVB_CODE, FOOTBALL_CATEGORIES } from './words.ts';

export const COMPETITION_CHIPS_MAX = 12;
export const CATEGORY_CHIPS_MAX = 6;
/** A competition is offered once it names this many events. */
const COMPETITION_MIN_EVENTS = 2;

export interface MatchChip { id: string; label: string }
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
      if (BROAD_SPORT_CATEGORIES.has(c) || DVB_CODE.test(c) || !labels.has(c)) continue;
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
