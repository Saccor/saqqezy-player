/** Sports candidates from one guide import, stored as meta `sportsIndex:<sourceId>` (spec §5.4; design note §3.1). */
import type { Programme } from '../types.ts';
import type { ProgrammeExtra } from '../xmltv/parse.ts';
import { copyString } from '../search/titleIndex.ts';
import { EVENT_THRESHOLD, mayBeEvent, scoreProgramme } from './detect.ts';
import { categoryKey, foldText, normSide } from './match.ts';

const H = 3600_000;
/** 3 h back / 24 h ahead, widened by the largest guide offset (±12 h); the query narrows it after the shift. */
const BACK_MS = 15 * H;
const AHEAD_MS = 36 * H;
export const SPORTS_MAX_CANDIDATES = 20_000;
/** Records without `v` (v1) keep the old row rules until the next guide refresh. */
export const SPORTS_INDEX_VERSION = 2;
/** A guide channel with this many sport programmes in the window is a sports channel (gate G2). */
export const SPORTY_MIN = 3;
const CATEGORIES_MAX = 256;
const CATS_PER_CANDIDATE = 4;

export interface SportsCandidate {
  epgKey: string; start: number; stop: number; title: string; nt: string;
  ns?: [string, string]; sides?: [string, string]; subTitle?: string; icon?: string; live: boolean;
  /** v2: indices into `SportsIndexRecord.categories`. */
  cats?: number[];
  /** v2: MATCH_FLAGS bits. */
  flags?: number;
  /** v2: competition text as the user's guide wrote it. */
  comp?: string;
}
export interface SportsIndexRecord {
  gen: number; built: number; candidates: SportsCandidate[]; truncated: boolean;
  /** 2 for records with the fields below; missing on v1 records. */
  v?: number;
  /** The guide's category texts (first spelling of each folded text). */
  categories?: string[];
  /** Guide channels that air SPORTY_MIN or more sport programmes in the window. */
  sportyKeys?: string[];
}

export function isSportsIndexRecord(v: unknown): v is SportsIndexRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<SportsIndexRecord>;
  return typeof r.gen === 'number' && typeof r.built === 'number' && Array.isArray(r.candidates) && typeof r.truncated === 'boolean';
}

export class SportsIndexBuilder {
  private readonly out: SportsCandidate[] = [];
  private readonly catIds = new Map<string, number>();
  private readonly catTexts: string[] = [];
  private readonly sporty = new Map<string, number>();
  truncated = false;

  constructor(private readonly now: number, private readonly max = SPORTS_MAX_CANDIDATES) {}

  private catId(text: string): number | undefined {
    const t = text.trim();
    if (!t) return undefined;
    const f = categoryKey(t);
    let id = this.catIds.get(f);
    if (id === undefined) {
      if (this.catTexts.length >= CATEGORIES_MAX) return undefined;
      id = this.catTexts.length;
      this.catIds.set(f, id);
      this.catTexts.push(copyString(t));
    }
    return id;
  }

  add(p: Programme, extra: ProgrammeExtra | undefined, epgKey: string): void {
    if (p.stop <= this.now - BACK_MS || p.start >= this.now + AHEAD_MS) return;
    if (!mayBeEvent(p.title, extra)) return;
    const d = scoreProgramme(p, extra);
    if (d.sportCat || (d.strong && d.live)) {
      const n = this.sporty.get(epgKey);
      // Map keys compare by value: the first (copied) key stays.
      this.sporty.set(n === undefined ? copyString(epgKey) : epgKey, (n ?? 0) + 1);
    }
    if (d.score < EVENT_THRESHOLD) return;
    if (this.out.length >= this.max) { this.truncated = true; return; }
    // Flat copies: parser strings are slices of large input chunks (see copyString).
    const title = copyString(d.cleanTitle);
    const c: SportsCandidate = { epgKey: copyString(epgKey), start: p.start, stop: p.stop, title, nt: foldText(title), live: d.live };
    if (d.sides) {
      c.sides = [copyString(d.sides[0]), copyString(d.sides[1])];
      c.ns = [normSide(c.sides[0]), normSide(c.sides[1])];
    }
    if (extra?.subTitle) c.subTitle = copyString(extra.subTitle);
    if (extra?.icon) c.icon = copyString(extra.icon);
    const cats = extra?.categories;
    if (cats?.length) {
      const ids: number[] = [];
      for (const t of cats) {
        const id = this.catId(t);
        if (id !== undefined && !ids.includes(id)) ids.push(id);
        if (ids.length >= CATS_PER_CANDIDATE) break;
      }
      if (ids.length) c.cats = ids;
    }
    c.flags = d.flags;
    if (d.comp) c.comp = copyString(d.comp);
    this.out.push(c);
  }

  build(): SportsCandidate[] {
    return this.out;
  }

  /** The stored v2 record. */
  record(gen: number, built: number): SportsIndexRecord {
    const sportyKeys: string[] = [];
    for (const [k, n] of this.sporty) if (n >= SPORTY_MIN) sportyKeys.push(k);
    return { gen, built, candidates: this.out, truncated: this.truncated, v: SPORTS_INDEX_VERSION, categories: this.catTexts, sportyKeys };
  }
}
