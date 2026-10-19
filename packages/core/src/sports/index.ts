/** Sports candidates from one guide import, stored as meta `sportsIndex:<sourceId>` (spec §5.4). */
import type { Programme } from '../types.ts';
import type { ProgrammeExtra } from '../xmltv/parse.ts';
import { copyString } from '../search/titleIndex.ts';
import { EVENT_THRESHOLD, mayBeEvent, scoreProgramme } from './detect.ts';
import { foldText, normSide } from './match.ts';

const H = 3600_000;
/** 3 h back / 24 h ahead, widened by the largest guide offset (±12 h); the query narrows it after the shift. */
const BACK_MS = 15 * H;
const AHEAD_MS = 36 * H;
export const SPORTS_MAX_CANDIDATES = 20_000;

export interface SportsCandidate {
  epgKey: string; start: number; stop: number; title: string; nt: string;
  ns?: [string, string]; sides?: [string, string]; subTitle?: string; icon?: string; live: boolean;
}
export interface SportsIndexRecord { gen: number; built: number; candidates: SportsCandidate[]; truncated: boolean }

export function isSportsIndexRecord(v: unknown): v is SportsIndexRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<SportsIndexRecord>;
  return typeof r.gen === 'number' && typeof r.built === 'number' && Array.isArray(r.candidates) && typeof r.truncated === 'boolean';
}

export class SportsIndexBuilder {
  private readonly out: SportsCandidate[] = [];
  truncated = false;

  constructor(private readonly now: number, private readonly max = SPORTS_MAX_CANDIDATES) {}

  add(p: Programme, extra: ProgrammeExtra | undefined, epgKey: string): void {
    if (p.stop <= this.now - BACK_MS || p.start >= this.now + AHEAD_MS) return;
    if (!mayBeEvent(p.title, extra)) return;
    const d = scoreProgramme(p, extra);
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
    this.out.push(c);
  }

  build(): SportsCandidate[] {
    return this.out;
  }
}
