import { searchKey } from '../text/searchKey.ts';

const MIN = 60_000;
const NL = 10; // "\n"
const SP = 32; // " "

/** Most airings one index holds; later airings are dropped (their titles still count). */
export const MAX_TITLE_AIRINGS = 1_000_000;

/**
 * Programme titles of one guide generation, deduped by `searchKey`, with their airings. Plain data
 * (structured-clone safe), so it is stored as one meta record. Times are whole minutes since the epoch.
 */
export interface TitleIndexData {
  v: 1;
  /** "\n" + key0 + "\n" + key1 + ... + "\n". */
  haystack: string;
  /** Start of key t in `haystack`, ascending. */
  offsets: Uint32Array;
  /** Display title of title t (first spelling seen). */
  display: string[];
  /** Airings of title t are [airFirst[t], airFirst[t + 1]); length = titles + 1. */
  airFirst: Uint32Array;
  /** Per airing (sorted by start within a title): index into `keys`. */
  airKey: Uint32Array;
  airStart: Uint32Array;
  airStop: Uint32Array;
  /** epgKey table. */
  keys: string[];
}

export interface TitleAiring { epgKey: string; start: number; stop: number }

export interface TitleMatch {
  titleId: number;
  display: string;
  /** 0 = the title starts with the query, 1 = a word does, 2 = substring. */
  rank: 0 | 1 | 2;
  /** Airings with stop > now, by start (raw guide times, ms). */
  airings: TitleAiring[];
}

export class TitleIndexBuilder {
  private readonly titles = new Map<string, { display: string; air: number[] }>();
  private readonly keyIds = new Map<string, number>();
  private readonly keys: string[] = [];
  private airings = 0;
  /** True once the airing cap was reached. */
  truncated = false;

  constructor(private readonly maxAirings = MAX_TITLE_AIRINGS) {}

  add(title: string, epgKey: string, start: number, stop: number): void {
    const key = searchKey(title);
    if (!key) return;
    let t = this.titles.get(key);
    if (!t) {
      t = { display: title.trim(), air: [] };
      this.titles.set(key, t);
    }
    if (this.airings >= this.maxAirings) {
      this.truncated = true;
      return;
    }
    let k = this.keyIds.get(epgKey);
    if (k === undefined) {
      k = this.keys.length;
      this.keys.push(epgKey);
      this.keyIds.set(epgKey, k);
    }
    t.air.push(k, Math.floor(start / MIN), Math.ceil(stop / MIN));
    this.airings++;
  }

  build(): TitleIndexData {
    const n = this.titles.size;
    const offsets = new Uint32Array(n);
    const display: string[] = new Array<string>(n);
    const airFirst = new Uint32Array(n + 1);
    const airKey = new Uint32Array(this.airings);
    const airStart = new Uint32Array(this.airings);
    const airStop = new Uint32Array(this.airings);
    const parts: string[] = [];
    let pos = 1;
    let a = 0;
    let t = 0;
    for (const [key, v] of this.titles) {
      offsets[t] = pos;
      parts.push(key);
      pos += key.length + 1;
      display[t] = v.display;
      airFirst[t] = a;
      const count = v.air.length / 3;
      const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => v.air[x * 3 + 1]! - v.air[y * 3 + 1]!);
      for (const i of order) {
        airKey[a] = v.air[i * 3]!;
        airStart[a] = v.air[i * 3 + 1]!;
        airStop[a] = v.air[i * 3 + 2]!;
        a++;
      }
      t++;
    }
    airFirst[n] = a;
    this.titles.clear();
    return { v: 1, haystack: `\n${parts.join('\n')}\n`, offsets, display, airFirst, airKey, airStart, airStop, keys: [...this.keys] };
  }
}

/** Title id whose key contains haystack position `pos` (largest t with offsets[t] <= pos). */
function titleAt(offsets: Uint32Array, pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** First airing of title t with stop > nowMin, or -1. */
function firstLive(d: TitleIndexData, t: number, nowMin: number): number {
  for (let a = d.airFirst[t]!; a < d.airFirst[t + 1]!; a++) if (d.airStop[a]! > nowMin) return a;
  return -1;
}

/**
 * Titles containing `query` (by `searchKey`) that still have an airing ending after `nowMs`. Sorted by rank,
 * then earliest remaining airing; at most `limit`. Scanning stops once `limit` rank-0 titles were found.
 */
export function queryTitles(data: TitleIndexData, query: string, nowMs: number, limit: number): TitleMatch[] {
  const q = searchKey(query);
  if (!q || limit <= 0 || data.offsets.length === 0) return [];
  const nowMin = nowMs / MIN;
  const best = new Map<number, { rank: 0 | 1 | 2; first: number }>();
  const dead = new Set<number>();
  const h = data.haystack;
  let rank0 = 0;
  let pos = h.indexOf(q);
  while (pos !== -1) {
    const t = titleAt(data.offsets, pos);
    const before = h.charCodeAt(pos - 1);
    const rank: 0 | 1 | 2 = before === NL ? 0 : before === SP ? 1 : 2;
    const prev = best.get(t);
    if (!dead.has(t) && (prev === undefined || rank < prev.rank)) {
      const first = prev?.first ?? firstLive(data, t, nowMin);
      if (first === -1) dead.add(t);
      else {
        best.set(t, { rank, first });
        if (rank === 0 && ++rank0 >= limit) break;
      }
    }
    // A rank-0 hit is the best this title can do: continue at the next title.
    pos = h.indexOf(q, rank === 0 ? (data.offsets[t + 1] ?? h.length) : pos + 1);
  }
  const out = [...best.entries()]
    .sort(([, x], [, y]) => x.rank - y.rank || data.airStart[x.first]! - data.airStart[y.first]!)
    .slice(0, limit);
  return out.map(([t, { rank, first }]) => {
    const airings: TitleAiring[] = [];
    for (let a = first; a < data.airFirst[t + 1]!; a++) {
      if (data.airStop[a]! <= nowMin) continue;
      airings.push({ epgKey: data.keys[data.airKey[a]!]!, start: data.airStart[a]! * MIN, stop: data.airStop[a]! * MIN });
    }
    return { titleId: t, display: data.display[t]!, rank, airings };
  });
}

/** Shape check for a record read back from storage. */
export function isTitleIndexData(x: unknown): x is TitleIndexData {
  if (typeof x !== 'object' || x === null) return false;
  const d = x as Partial<TitleIndexData>;
  if (d.v !== 1 || typeof d.haystack !== 'string' || !Array.isArray(d.display) || !Array.isArray(d.keys)) return false;
  const arrays = [d.offsets, d.airFirst, d.airKey, d.airStart, d.airStop];
  if (!arrays.every((a) => a instanceof Uint32Array)) return false;
  const n = d.offsets!.length;
  const m = d.airKey!.length;
  return d.display.length === n && d.airFirst!.length === n + 1 && d.airFirst![n] === m
    && d.airStart!.length === m && d.airStop!.length === m;
}
