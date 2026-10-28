/** Is this guide programme a sports event, and what are its two sides? Pure; spec §5.2. */
import type { ProgrammeExtra } from '../xmltv/parse.ts';
import { foldText } from '../text/fold.ts';
import { categoryKey } from './match.ts';
import { LIVE_WORDS, MATCH_FLAGS, descFlags, isGenericCategory, isSportCategory, isStage, tagFlags } from './words.ts';

export const EVENT_THRESHOLD = 3;
const SHORT_MS = 45 * 60_000;
/** Only this much of a description is scanned for replay words; it is never stored. */
const DESC_SCAN = 300;
/** A longer sub-title reads like a description: only the strict replay words count there. */
const SUBTITLE_TAG_WORDS = 6;

export { SPORT_CATEGORIES } from './words.ts';
/** Upper case, or any case with a separator: "LIVE Lakeshore - Pinecrest", "live: …", "(L) …". */
const LIVE_PREFIX = /^\s*(?:(?:LIVE|DIREKT|EN VIVO|EN DIRECT)\b\s*[:|\-–]?|(?:live|direkt|en vivo|en direct)\s*[:|\-–]|\(L\))\s*/i;
const LIVE_UPPER = /^\s*(?:LIVE|DIREKT|EN VIVO|EN DIRECT|\(L\))/;
const NEGATIVE = /\b(?:highlights|replay|classic|review|magazine|preview|rerun|repris)\b|\(r\)/i;
/** Strong separators say "A plays B"; weak ones (`-`, `x`, `@`) split many other titles too. */
const STRONG_SEP = /\s+(?:v|vs\.?|gegen|mot)\s+/i;
const WEAK_SEP = /\s+(?:-|–|—|x|@)\s+/i;

/** Cheap pre-check: the text has a match separator, so `parseMatch` may find two sides. No allocations. */
export function hasMatchSeparator(text: string): boolean {
  return STRONG_SEP.test(text) || WEAK_SEP.test(text);
}
/** A competition prefix ends at its last `: ` or ` | ` (or a dash, before a strong separator). */
const PREFIX_STRONG = /:\s|\s\|\s|\s[-–—]\s/g;
const PREFIX_WEAK = /:\s|\s\|\s/g;
/** Where a suffix after side B starts. */
const SUFFIX = /\s[-–—|]\s|:\s|,\s|\s?[([]/;
const PIECES = /\s[-–—|]\s|:\s|,\s|[()[\]]/;
const SIDE_MAX_WORDS = 5;
const COMP_MAX = 40;

export interface Detection {
  score: number; cleanTitle: string; sides?: [string, string]; live: boolean;
  /** MATCH_FLAGS bits. */
  flags: number;
  /** Competition text as the guide wrote it (title prefix or suffix, sub-title, or a non-generic category). */
  comp?: string;
  /** The sides were split on a strong separator. */
  strong: boolean;
  /** A sport category or DVB sport code. */
  sportCat: boolean;
}

export interface ParsedMatch { sides: [string, string]; title: string; strong: boolean; comp?: string; live: boolean }

function validSide(s: string): boolean {
  if (s.length < 2 || s.length > 40 || /^\d+$/.test(s) || /[:|]/.test(s)) return false;
  if (s.split(/\s+/).length > SIDE_MAX_WORDS) return false;
  return tagFlags(foldText(s)) === 0;
}

/** The first piece of `text` that can name a competition; live words set `live`. Stages and tags never name one. */
function pieceComp(text: string): { comp?: string; live: boolean } {
  let live = false;
  let comp: string | undefined;
  for (const raw of text.split(PIECES)) {
    const piece = raw.trim();
    if (!piece) continue;
    const f = foldText(piece);
    if (LIVE_WORDS.has(f)) { live = true; continue; }
    if (comp !== undefined || tagFlags(f) !== 0 || isStage(f) || f.length < 2 || piece.length > COMP_MAX) continue;
    if (piece.split(/\s+/).length > SIDE_MAX_WORDS + 1) continue;
    comp = piece;
  }
  return comp === undefined ? { live } : { comp, live };
}

function lastIndexOf(re: RegExp, s: string): { at: number; len: number } | undefined {
  re.lastIndex = 0;
  let last: { at: number; len: number } | undefined;
  for (let m = re.exec(s); m; m = re.exec(s)) last = { at: m.index, len: m[0].length };
  return last;
}

/**
 * Two sides of a match title (design note §3.2): the strongest separator splits; a competition prefix and a suffix
 * (tags, live, stage, or the competition) are peeled. Undefined when there are no valid sides.
 */
export function parseMatch(text: string): ParsedMatch | undefined {
  const s = text.trim();
  let sep = STRONG_SEP.exec(s);
  const strong = sep !== null;
  if (!sep) sep = WEAK_SEP.exec(s);
  if (!sep) return undefined;
  let left = s.slice(0, sep.index);
  let right = s.slice(sep.index + sep[0].length);
  let live = false;
  let comp: string | undefined;
  const pre = lastIndexOf(strong ? PREFIX_STRONG : PREFIX_WEAK, left);
  if (pre) {
    const p = pieceComp(left.slice(0, pre.at));
    if (p.comp) comp = p.comp;
    live ||= p.live;
    left = left.slice(pre.at + pre.len);
  }
  const suf = SUFFIX.exec(right);
  if (suf) {
    const p = pieceComp(right.slice(suf.index));
    if (p.comp && comp === undefined) comp = p.comp;
    live ||= p.live;
    right = right.slice(0, suf.index);
  }
  const a = left.trim();
  const b = right.trim();
  if (!validSide(a) || !validSide(b)) return undefined;
  const out: ParsedMatch = { sides: [a, b], title: `${a}${sep[0]}${b}`, strong, live };
  if (comp !== undefined) out.comp = comp;
  return out;
}

function stripLive(title: string): { rest: string; live: boolean } {
  const m = LIVE_PREFIX.exec(title);
  // Mixed-case "Live" with no separator ("Live at the Hall") is a title, not a prefix.
  if (!m || (!/[:|\-–]/.test(m[0]) && !LIVE_UPPER.test(title))) return { rest: title, live: false };
  return { rest: title.slice(m[0].length), live: true };
}

/**
 * Cheap pre-check for the index builder: without a sport category hit or a live marker (flag or title prefix) a programme
 * scores at most 2 (sides 2, or 1 from the subtitle), below EVENT_THRESHOLD, so `scoreProgramme` can be skipped. No allocations.
 */
export function mayBeEvent(title: string, extra?: ProgrammeExtra): boolean {
  if (extra?.live === true) return true;
  const cats = extra?.categories;
  if (cats) {
    for (let i = 0; i < cats.length; i++) {
      if (isSportCategory(categoryKey(cats[i]!))) return true;
    }
  }
  return stripLive(title).live;
}

export function scoreProgramme(p: { title: string; start: number; stop: number; desc?: string }, extra?: ProgrammeExtra): Detection {
  let score = 0;
  const raw = extra?.categories ?? [];
  const cats = raw.map(categoryKey);
  const sportCat = cats.some(isSportCategory);
  if (sportCat) score += 2;
  if (cats.includes('0x42')) score -= 3;

  const { rest, live: prefixLive } = stripLive(p.title);
  let cleanTitle = rest.trim();
  let live = prefixLive || extra?.live === true;

  let sides: [string, string] | undefined;
  let strong = false;
  let comp: string | undefined;
  const m = parseMatch(cleanTitle);
  if (m) {
    sides = m.sides; strong = m.strong; cleanTitle = m.title; live ||= m.live;
    if (m.comp) comp = m.comp;
    score += 2;
  } else if (extra?.subTitle) {
    const sm = parseMatch(extra.subTitle);
    if (sm) { sides = sm.sides; strong = sm.strong; live ||= sm.live; if (sm.comp) comp = sm.comp; score += 1; }
  }
  if (live) score += 2;

  if (NEGATIVE.test(p.title) || (extra?.subTitle !== undefined && NEGATIVE.test(extra.subTitle)) || extra?.rerun) score -= 3;
  if (sides && p.stop - p.start < SHORT_MS && !live) score -= 2;

  let flags = tagFlags(foldText(p.title));
  const sub = extra?.subTitle;
  if (sub) {
    const fs = foldText(sub);
    flags |= sub.trim().split(/\s+/).length <= SUBTITLE_TAG_WORDS ? tagFlags(fs) : descFlags(fs);
    // The sub-title names the competition when it is not sides, not a tag and not only a stage.
    if (comp === undefined && tagFlags(fs) === 0 && !parseMatch(sub)) {
      const pc = pieceComp(sub);
      if (pc.comp) comp = pc.comp;
    }
  }
  if (p.desc) flags |= descFlags(foldText(p.desc.slice(0, DESC_SCAN)));
  if (live) flags |= MATCH_FLAGS.live;
  if (extra?.rerun) flags |= MATCH_FLAGS.rerun;
  if (sides && !strong) flags |= MATCH_FLAGS.weakSep;
  if (comp === undefined) {
    for (let i = 0; i < cats.length; i++) {
      const c = raw[i]!.trim();
      if (c.length >= 2 && c.length <= COMP_MAX && !isGenericCategory(cats[i]!)) { comp = c; break; }
    }
  }

  const out: Detection = { score, cleanTitle, live, flags, strong, sportCat };
  if (sides) out.sides = sides;
  if (comp !== undefined) out.comp = comp;
  return out;
}
