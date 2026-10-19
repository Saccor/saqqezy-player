import { baseOf, HAS_TEXT, HAS_TOKEN, NO_TAGS, peelPrefix, prepare, QUALITY_UNKNOWN, stripTags, tidy } from '../text/nameTags.ts';

export { QUALITY_LABELS, QUALITY_UNKNOWN } from '../text/nameTags.ts';

/** A catalogue title split into what it is called and what version it is. */
export interface ParsedTitle {
  /** Prefixes and tags removed, original casing ("Synthetic Film"). */
  display: string;
  /** Match key: folded, punctuation-free, roman numerals as digits, numbers kept ("synthetic film 2"). */
  base: string;
  year?: number;
  /** ISO 639-1 ("sv"), from a leading prefix of the title, else of its category name. */
  lang?: string;
  /** 0 = 4K/UHD, 1 = FHD/1080p, 2 = HD/720p, 3 = SD, 4 = unknown. */
  quality: number;
  /** In `TAG_ORDER` order. */
  tags: string[];
}

/**
 * Words of ASCII letters (and apostrophes), one space apart: no digit (no year, no "4K-" prefix), no bracket and no
 * separator (no prefix, nothing to tidy). Unless it holds a token, such a title is its own display.
 */
const SIMPLE = /^[A-Za-z']+(?: [A-Za-z']+)*$/;
const MAX_YEAR = new Date().getFullYear() + 1;
/** A bracketed year at the given position (sticky). */
const YEAR_AT = /[([]\s*((?:19|20)\d{2})\s*[)\]]/y;
const ENDS_IN_YEAR = /(?:19|20)\d{2}\s*$/;
const YEAR_TRAILING = /(?:\s[-–—]\s*|\s)((?:19|20)\d{2})\s*$/;

function takeYear(s: string): { rest: string; year?: number } {
  // A year must leave some title behind ("1917" alone is a title, not a year).
  // The last bracketed year: try each "(" or "[" from the end.
  for (let at = lastBracket(s, s.length - 1); at >= 0; at = lastBracket(s, at - 1)) {
    YEAR_AT.lastIndex = at;
    const m = YEAR_AT.exec(s);
    if (!m || !isYear(Number(m[1]))) continue;
    const rest = s.slice(0, at) + ' ' + s.slice(at + m[0].length);
    if (asciiAlnumBefore(s, at) || HAS_TEXT.test(rest)) return { rest, year: Number(m[1]) };
    break;
  }
  if (!ENDS_IN_YEAR.test(s)) return { rest: s };
  const end = s.trimEnd();
  const t = YEAR_TRAILING.exec(end);
  if (t && isYear(Number(t[1]))) {
    const rest = end.slice(0, t.index);
    if (asciiAlnumBefore(end, t.index) || HAS_TEXT.test(rest)) return { rest, year: Number(t[1]) };
  }
  return { rest: s };
}

/** Whether `s` has an ASCII letter or digit before `end`: the cheap answer to `HAS_TEXT` for most titles. */
function asciiAlnumBefore(s: string, end: number): boolean {
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i) | 32; // folds A-Z onto a-z; digits stay apart from letters
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) return true;
  }
  return false;
}

function isYear(y: number): boolean {
  return y >= 1900 && y <= MAX_YEAR;
}

function lastBracket(s: string, from: number): number {
  return from < 0 ? -1 : Math.max(s.lastIndexOf('(', from), s.lastIndexOf('[', from));
}

/** The language of a leading prefix of `name`, if any (a category name such as "SE | Action"). */
export function prefixLang(name: string): string | undefined {
  return peelPrefix(prepare(name))?.lang;
}

export function parseVodTitle(title: string, categoryName?: string): ParsedTitle {
  const raw = prepare(title);
  if (SIMPLE.test(raw) && !HAS_TOKEN.test(raw)) {
    const simple: ParsedTitle = { display: raw, base: baseOf(raw), quality: QUALITY_UNKNOWN, tags: NO_TAGS };
    const catLang = categoryName ? prefixLang(categoryName) : undefined;
    if (catLang) simple.lang = catLang;
    return simple;
  }
  const peeled = peelPrefix(raw);
  const tagged = stripTags(peeled ? peeled.rest : raw);
  const dated = takeYear(tagged.rest);
  let display = tidy(dated.rest);
  if (!display) display = raw;
  const out: ParsedTitle = { display, base: baseOf(display), quality: Math.min(tagged.quality, peeled?.quality ?? QUALITY_UNKNOWN), tags: tagged.tags };
  if (dated.year !== undefined && display !== raw) out.year = dated.year;
  const lang = peeled?.lang ?? (categoryName ? prefixLang(categoryName) : undefined);
  if (lang) out.lang = lang;
  return out;
}

/** A category name without language or quality: "SE | Action", "Action 4K" → base "action". */
export function categoryBase(name: string): { base: string; display: string } {
  const raw = prepare(name);
  const peeled = peelPrefix(raw);
  const display = tidy(stripTags(peeled ? peeled.rest : raw).rest) || raw;
  return { base: baseOf(display), display };
}
