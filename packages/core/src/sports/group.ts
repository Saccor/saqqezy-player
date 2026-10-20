/** Groups detected sports programmes into one event per match across channels (spec §5.3). Pure. */
import { resolveAlias, sideMatch as baseSideMatch } from './match.ts';

const WINDOW_MS = 30 * 60_000;

export interface GroupInput<A> {
  /** Normalised sides (sorted order not required) or undefined for a title-only event. */
  ns?: [string, string];
  /** Normalised clean title (for title-only events). */
  nt: string;
  title: string; sides?: [string, string]; subTitle?: string; icon?: string;
  start: number; stop: number; live: boolean;
  airing: A;
}
export interface SportsGroup<A> {
  key: string; title: string; sides?: [string, string]; subTitle?: string; icon?: string;
  start: number; stop: number; live: boolean; airings: A[];
}

interface Open<A> {
  key: string; ns?: [string, string]; first: number; start: number; stop: number; live: boolean;
  airings: A[]; ids: Set<string>; titles: Map<string, { n: number; item: GroupInput<A> }>;
}

/** A fuzzy match never bridges different numbers ("u19" vs "u21", "team 5" vs "team 681"): those are different sides. */
function sideMatch(a: string, b: string): 'exact' | 'fuzzy' | undefined {
  const m = baseSideMatch(a, b);
  if (m === 'fuzzy' && a.replace(/\D/g, '') !== b.replace(/\D/g, '')) return undefined;
  return m;
}

const pairKey = (a: string, b: string) => `p:${a < b ? `${a}|${b}` : `${b}|${a}`}`;
const bucketsOf = (ns: [string, string]) => [ns[0].slice(0, 2), ns[1].slice(0, 2)];

function closeInTime(g: { first: number; start: number; stop: number }, s: number, e: number): boolean {
  if (Math.abs(s - g.first) <= WINDOW_MS) return true;
  const overlap = Math.min(e, g.stop) - Math.max(s, g.start);
  return overlap > 0 && overlap >= 0.5 * Math.min(e - s, g.stop - g.start);
}

/** How sides `b` match group sides `a` (either order): both exact; one exact and one fuzzy (`from` is b's spelling); both fuzzy; or no match. */
function pairMatch(a: [string, string], b: [string, string]): { kind: 'exact' } | { kind: 'oneFuzzy'; from: string; to: string } | { kind: 'loose' } | undefined {
  for (const [x, y] of [[b[0], b[1]], [b[1], b[0]]] as const) {
    const m0 = sideMatch(a[0], x);
    const m1 = sideMatch(a[1], y);
    if (!m0 || !m1) continue;
    if (m0 === 'exact' && m1 === 'exact') return { kind: 'exact' };
    if (m0 === 'exact') return { kind: 'oneFuzzy', from: y, to: a[1] };
    if (m1 === 'exact') return { kind: 'oneFuzzy', from: x, to: a[0] };
    return { kind: 'loose' };
  }
  return undefined;
}

export function groupEvents<A>(
  items: GroupInput<A>[], aliases: ReadonlyMap<string, string>, airingId: (a: A) => string,
): { events: SportsGroup<A>[]; learned: [from: string, to: string][] } {
  const sorted = [...items].sort((x, y) => x.start - y.start);
  const done: Open<A>[] = [];
  let open: Open<A>[] = [];
  const byKey = new Map<string, Open<A>[]>();
  const byBucket = new Map<string, Open<A>[]>();
  const seen = new Map<string, { pair: [string, string]; ids: Set<string> }>();

  let lastSweep = -Infinity;

  const index = (g: Open<A>) => {
    (byKey.get(g.key) ?? byKey.set(g.key, []).get(g.key)!).push(g);
    if (g.ns) for (const b of bucketsOf(g.ns)) (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(g);
  };

  for (const it of sorted) {
    // Groups that can no longer take a later-starting item leave the open set.
    if (open.length > 64 && it.start >= lastSweep + WINDOW_MS) {
      lastSweep = it.start;
      const keep: Open<A>[] = [];
      for (const g of open) (g.first < it.start - WINDOW_MS && g.stop <= it.start ? done : keep).push(g);
      if (keep.length !== open.length) {
        open = keep;
        const live = new Set(open);
        for (const [k, list] of byKey) { const l = list.filter((g) => live.has(g)); if (l.length) byKey.set(k, l); else byKey.delete(k); }
        for (const [k, list] of byBucket) { const l = list.filter((g) => live.has(g)); if (l.length) byBucket.set(k, l); else byBucket.delete(k); }
      }
    }
    // Sides that normalise to nothing carry no pairing: fall back to the title.
    const ns = it.ns && it.ns[0] !== '' && it.ns[1] !== ''
      ? ([resolveAlias(it.ns[0], aliases), resolveAlias(it.ns[1], aliases)] as [string, string])
      : undefined;
    const key = ns ? pairKey(ns[0], ns[1]) : `t:${it.nt}`;
    let target = byKey.get(key)?.find((g) => closeInTime(g, it.start, it.stop));
    if (!target && ns) {
      const cands = new Set<Open<A>>();
      for (const b of bucketsOf(ns)) for (const g of byBucket.get(b) ?? []) cands.add(g);
      for (const g of cands) {
        if (!g.ns || !closeInTime(g, it.start, it.stop)) continue;
        const m = pairMatch(g.ns, ns);
        if (!m) continue;
        target = g;
        if (m.kind === 'oneFuzzy') {
          const k = `${m.from}\u0000${m.to}`;
          const s = seen.get(k) ?? seen.set(k, { pair: [m.from, m.to], ids: new Set() }).get(k)!;
          s.ids.add(airingId(it.airing));
        }
        break;
      }
    }
    if (!target) {
      target = { key, first: it.start, start: it.start, stop: it.stop, live: false, airings: [], ids: new Set(), titles: new Map() };
      if (ns) target.ns = ns;
      open.push(target);
      index(target);
    }
    const aid = airingId(it.airing);
    target.start = Math.min(target.start, it.start);
    target.stop = Math.max(target.stop, it.stop);
    target.live ||= it.live;
    const t = target.titles.get(it.title);
    if (t) t.n++;
    else target.titles.set(it.title, { n: 1, item: it });
    if (!target.ids.has(aid)) { target.ids.add(aid); target.airings.push(it.airing); }
  }

  const events = [...done, ...open].map((g): SportsGroup<A> => {
    let best: { n: number; item: GroupInput<A> } | undefined;
    for (const [title, v] of g.titles) {
      if (!best || v.n > best.n || (v.n === best.n && title.length > best.item.title.length)) best = v;
    }
    const src = best!.item;
    const e: SportsGroup<A> = { key: `${g.key}@${g.first}`, title: src.title, start: g.start, stop: g.stop, live: g.live, airings: g.airings };
    if (src.sides) e.sides = src.sides;
    if (src.subTitle) e.subTitle = src.subTitle;
    const icon = [...g.titles.values()].find((v) => v.item.icon)?.item.icon;
    if (icon) e.icon = icon;
    return e;
  }).sort((a, b) => a.start - b.start);
  const learned = [...seen.values()].filter((s) => s.ids.size >= 2).map((s) => s.pair);
  return { events, learned };
}

/** An earlier cluster counts for G3 only if it would pass G5 itself: a short untagged preview slot is no match. */
const REAIR_MIN_LEN_MS = 60 * 60_000;

/**
 * Re-airs by pairing (gate G3): a match whose pair already had an earlier event that ended before this one started,
 * unless this one is live-marked. The earlier event must itself look like the match (60 min or more, or live-marked)
 * and be carried at least as widely (airings), so a preview slot or a one-channel replay never hides the real match in
 * a guide that never marks live. Title-only events are never marked. `events` sorted by start (as groupEvents returns).
 */
export function reairKeys<A>(events: readonly SportsGroup<A>[]): Set<string> {
  const out = new Set<string>();
  const earlier = new Map<string, { stop: number; n: number }[]>();
  for (const e of events) {
    if (!e.key.startsWith('p:')) continue;
    const pair = e.key.slice(0, e.key.lastIndexOf('@'));
    const prev = earlier.get(pair);
    const n = e.airings.length;
    if (prev && !e.live && prev.some((p) => p.stop <= e.start && p.n >= n)) out.add(e.key);
    if (e.live || e.stop - e.start >= REAIR_MIN_LEN_MS) {
      if (prev) prev.push({ stop: e.stop, n }); else earlier.set(pair, [{ stop: e.stop, n }]);
    }
  }
  return out;
}
