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

interface TitleEntry { display: string; air: number[] }

export class TitleIndexBuilder {
  private readonly titles = new Map<string, TitleEntry>();
  /** Raw spelling -> its deduped entry (null: the title has an empty key). Each spelling is normalised once. */
  private readonly byRaw = new Map<string, TitleEntry | null>();
  private readonly keyIds = new Map<string, number>();
  private readonly keys: string[] = [];
  private lastEpgKey: string | undefined;
  private lastKeyId = 0;
  private airings = 0;
  /** True once the airing cap was reached. */
  truncated = false;

  constructor(private readonly maxAirings = MAX_TITLE_AIRINGS) {}

  add(title: string, epgKey: string, start: number, stop: number): void {
    let t = this.byRaw.get(title);
    if (t === undefined) {
      const key = searchKey(title);
      if (key) {
        t = this.titles.get(key);
        if (!t) {
          t = { display: title.trim(), air: [] };
          this.titles.set(key, t);
        }
      } else t = null;
      this.byRaw.set(title, t);
    }
    if (t === null) return;
    if (this.airings >= this.maxAirings) {
      this.truncated = true;
      return;
    }
    let k: number;
    if (epgKey === this.lastEpgKey) k = this.lastKeyId;
    else {
      let id = this.keyIds.get(epgKey);
      if (id === undefined) {
        id = this.keys.length;
        this.keys.push(epgKey);
        this.keyIds.set(epgKey, id);
      }
      k = id;
      this.lastEpgKey = epgKey;
      this.lastKeyId = id;
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
    this.byRaw.clear();
    this.lastEpgKey = undefined;
    return { v: 1, haystack: `\n${parts.join('\n')}\n`, offsets, display, airFirst, airKey, airStart, airStop, keys: [...this.keys] };
  }
}

/** Title id whose key contains haystack position `pos` (largest t with offsets[t] <= pos). */
function titleAt(offsets: Uint32Array, pos: number, from = 0): number {
  let lo = from; // callers pass a lower bound: positions only increase during a scan
  if (lo + 1 < offsets.length && offsets[lo + 1]! > pos) return lo;
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

/** True when candidate i (start si, id ti) sorts after candidate j: later start, or same start and higher id. */
function after(starts: number[], ids: number[], i: number, j: number): boolean {
  return starts[i]! > starts[j]! || (starts[i] === starts[j] && ids[i]! > ids[j]!);
}

/** Indices of the `k` earliest candidates (by start, then id), ascending. Bounded max-heap: O(n log k). */
function earliest(ids: number[], starts: number[], k: number): number[] {
  const n = ids.length;
  const heap: number[] = [];
  if (n <= k) for (let i = 0; i < n; i++) heap.push(i);
  else {
    // Max-heap on (start, id): the root is the worst of the k kept.
    for (let i = 0; i < k; i++) {
      let c = heap.push(i) - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (!after(starts, ids, heap[c]!, heap[p]!)) break;
        [heap[c], heap[p]] = [heap[p]!, heap[c]!];
        c = p;
      }
    }
    for (let i = k; i < n; i++) {
      if (!after(starts, ids, heap[0]!, i)) continue;
      heap[0] = i;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        if (l >= k) break;
        const c = l + 1 < k && after(starts, ids, heap[l + 1]!, heap[l]!) ? l + 1 : l;
        if (!after(starts, ids, heap[c]!, heap[p]!)) break;
        [heap[c], heap[p]] = [heap[p]!, heap[c]!];
        p = c;
      }
    }
  }
  return heap.sort((x, y) => starts[x]! - starts[y]! || ids[x]! - ids[y]!);
}

// Per-title scan state (Uint8Array, one byte per title).
const DEAD = 1; // no live airing: ignore
const SEEN2 = 2; // recorded at rank 2 (a later rank-1 hit may still upgrade it)
const DONE = 3; // recorded at rank 0 or 1: final

/**
 * Titles containing `query` (by `searchKey`) that still have an airing ending after `nowMs`. Sorted by rank,
 * then earliest remaining airing (then title id); at most `limit`. Scanning stops once `limit` rank-0 titles
 * were found. Rank-1 and rank-2 titles are chosen with a bounded heap, so a query matching most titles costs
 * O(hits log limit), not a full sort.
 */
export function queryTitles(data: TitleIndexData, query: string, nowMs: number, limit: number): TitleMatch[] {
  const q = searchKey(query);
  if (!q || limit <= 0 || data.offsets.length === 0) return [];
  const nowMin = nowMs / MIN;
  const state = new Uint8Array(data.offsets.length);
  // Candidates per rank: title id and the start of its first live airing.
  const ids: [number[], number[], number[]] = [[], [], []];
  const starts: [number[], number[], number[]] = [[], [], []];
  const h = data.haystack;
  let pos = h.indexOf(q);
  let t = 0;
  while (pos !== -1) {
    t = titleAt(data.offsets, pos, t);
    const next = data.offsets[t + 1] ?? h.length; // where the next title's key begins
    const st = state[t]!;
    const before = h.charCodeAt(pos - 1);
    const rank: 0 | 1 | 2 = before === NL ? 0 : before === SP ? 1 : 2;
    if (st === SEEN2 && rank === 2) {
      pos = h.indexOf(q, pos + 1);
      continue;
    }
    const first = firstLive(data, t, nowMin);
    if (first === -1) {
      state[t] = DEAD;
      pos = h.indexOf(q, next);
      continue;
    }
    ids[rank].push(t);
    starts[rank].push(data.airStart[first]!);
    if (rank === 2) {
      state[t] = SEEN2;
      pos = h.indexOf(q, pos + 1); // a later word-start hit in this title would beat rank 2
    } else {
      state[t] = DONE; // rank 0 is a title's first position; rank 1 can only be beaten by rank 0, which came earlier
      if (rank === 0 && ids[0].length >= limit) break;
      pos = h.indexOf(q, next);
    }
  }
  // Titles upgraded from rank 2 are stale in the rank-2 list.
  let w = 0;
  for (let i = 0; i < ids[2].length; i++) {
    if (state[ids[2][i]!] !== SEEN2) continue;
    ids[2][w] = ids[2][i]!;
    starts[2][w++] = starts[2][i]!;
  }
  ids[2].length = starts[2].length = w;

  const out: TitleMatch[] = [];
  for (const rank of [0, 1, 2] as const) {
    const room = limit - out.length;
    if (room <= 0) break;
    for (const i of earliest(ids[rank], starts[rank], room)) {
      const t = ids[rank][i]!;
      const airings: TitleAiring[] = [];
      for (let a = firstLive(data, t, nowMin); a < data.airFirst[t + 1]!; a++) {
        if (data.airStop[a]! <= nowMin) continue;
        airings.push({ epgKey: data.keys[data.airKey[a]!]!, start: data.airStart[a]! * MIN, stop: data.airStop[a]! * MIN });
      }
      out.push({ titleId: t, display: data.display[t]!, rank, airings });
    }
  }
  return out;
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
