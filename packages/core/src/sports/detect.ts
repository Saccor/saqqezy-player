/** Is this guide programme a sports event, and what are its two sides? Pure; spec §5.2. */
import type { ProgrammeExtra } from '../xmltv/parse.ts';
import { foldText } from './match.ts';

export const EVENT_THRESHOLD = 3;
const SHORT_MS = 45 * 60_000;

/** Folded (lowercase, no accents). Generic sport words only; never competition or club names. */
export const SPORT_CATEGORIES: ReadonlySet<string> = new Set([
  'sport', 'sports', 'sports event', 'sporting event', 'football', 'soccer', 'fotboll', 'fussball', 'fußball', 'deportes',
  'futbol', 'calcio', 'ice hockey', 'ishockey', 'hockey', 'basketball', 'tennis', 'motorsport', 'handball', 'rugby',
  'cricket', 'boxing', 'mma', 'golf',
]);
const DVB_SPORT = /^0x4[0-9a-b]$/;
const DVB_MAGAZINE = '0x42';
/** Upper case, or any case with a separator: "LIVE Lakeshore - Pinecrest", "live: …", "(L) …". */
const LIVE_PREFIX = /^\s*(?:(?:LIVE|DIREKT|EN VIVO|EN DIRECT)\b\s*[:|\-–]?|(?:live|direkt|en vivo|en direct)\s*[:|\-–]|\(L\))\s*/i;
const LIVE_UPPER = /^\s*(?:LIVE|DIREKT|EN VIVO|EN DIRECT|\(L\))/;
const SIDES = /^(.{2,40}?)\s+(?:v|vs\.?|-|–|—|x|@|gegen|mot)\s+(.{2,40})$/i;
const NEGATIVE = /\b(?:highlights|replay|classic|review|magazine|preview|rerun|repris)\b|\(r\)/i;

export interface Detection { score: number; cleanTitle: string; sides?: [string, string]; live: boolean }

function sidesOf(s: string): [string, string] | undefined {
  const m = SIDES.exec(s.trim());
  if (!m) return undefined;
  const a = m[1]!.trim();
  const b = m[2]!.trim();
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return undefined;
  return [a, b];
}

function stripLive(title: string): { rest: string; live: boolean } {
  const m = LIVE_PREFIX.exec(title);
  // Mixed-case "Live" with no separator ("Live at the Hall") is a title, not a prefix.
  if (!m || (!/[:|\-–]/.test(m[0]) && !LIVE_UPPER.test(title))) return { rest: title, live: false };
  return { rest: title.slice(m[0].length), live: true };
}

export function scoreProgramme(p: { title: string; start: number; stop: number }, extra?: ProgrammeExtra): Detection {
  let score = 0;
  const cats = (extra?.categories ?? []).map((c) => foldText(c.trim()));
  if (cats.some((c) => SPORT_CATEGORIES.has(c) || (DVB_SPORT.test(c) && c !== DVB_MAGAZINE))) score += 2;
  if (cats.includes(DVB_MAGAZINE)) score -= 3;

  const { rest, live: prefixLive } = stripLive(p.title);
  let cleanTitle = rest.trim();
  const live = prefixLive || extra?.live === true;
  if (live) score += 2;

  // A "Competition: " prefix is dropped first; otherwise the whole title would split as "Competition: Side".
  let sides: [string, string] | undefined;
  const colon = cleanTitle.indexOf(': ');
  if (colon > 0) {
    const after = cleanTitle.slice(colon + 2);
    const s = sidesOf(after);
    if (s) { sides = s; cleanTitle = after.trim(); }
  }
  if (!sides) sides = sidesOf(cleanTitle);
  if (sides) score += 2;
  else if (extra?.subTitle) {
    const s = sidesOf(extra.subTitle);
    if (s) { sides = s; score += 1; }
  }

  if (NEGATIVE.test(p.title) || (extra?.subTitle !== undefined && NEGATIVE.test(extra.subTitle)) || extra?.rerun) score -= 3;
  if (sides && p.stop - p.start < SHORT_MS && !live) score -= 2;

  const out: Detection = { score, cleanTitle, live };
  if (sides) out.sides = sides;
  return out;
}
