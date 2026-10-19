import { searchKey } from '../text/searchKey.ts';

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

export const QUALITY_UNKNOWN = 4;
/** Badge per quality rank ('' for unknown). */
export const QUALITY_LABELS: readonly string[] = ['4K', 'FHD', 'HD', 'SD', ''];

/**
 * Upper-case prefix code → ISO 639-1. ISO 639-1 and 639-2 codes plus the country codes playlists use for a language.
 * Closed on purpose: a word not in here is never taken for a prefix ("UP - …" stays part of the title).
 */
const LANG_CODES: Record<string, string> = {
  EN: 'en', ENG: 'en', UK: 'en', GB: 'en', US: 'en', USA: 'en',
  SV: 'sv', SWE: 'sv', SE: 'sv',
  DA: 'da', DAN: 'da', DK: 'da',
  NO: 'no', NOR: 'no', NB: 'no',
  FI: 'fi', FIN: 'fi',
  DE: 'de', GER: 'de', DEU: 'de', AT: 'de', CH: 'de',
  FR: 'fr', FRE: 'fr', FRA: 'fr',
  ES: 'es', SPA: 'es', LAT: 'es', MX: 'es',
  IT: 'it', ITA: 'it',
  PT: 'pt', POR: 'pt', BR: 'pt', 'PT-BR': 'pt',
  NL: 'nl', NLD: 'nl', DUT: 'nl', BE: 'nl',
  PL: 'pl', POL: 'pl',
  TR: 'tr', TUR: 'tr',
  EL: 'el', GRE: 'el', ELL: 'el', GR: 'el',
  HE: 'he', HEB: 'he', IL: 'he',
  HI: 'hi', HIN: 'hi', IN: 'hi',
  JA: 'ja', JPN: 'ja', JP: 'ja',
  KO: 'ko', KOR: 'ko', KR: 'ko',
  ZH: 'zh', CHI: 'zh', ZHO: 'zh', CN: 'zh',
  RU: 'ru', RUS: 'ru',
  UA: 'uk', UKR: 'uk',
  AR: 'ar', ARA: 'ar',
  FA: 'fa', PER: 'fa', FAS: 'fa', IR: 'fa',
  CS: 'cs', CZE: 'cs', CES: 'cs', CZ: 'cs',
  HU: 'hu', HUN: 'hu',
  RO: 'ro', RUM: 'ro', RON: 'ro',
  TH: 'th', THA: 'th',
  VI: 'vi', VIE: 'vi', VN: 'vi',
  ID: 'id', IND: 'id',
};

/** "|SE| ", "[EN] ", "(EN) ", "EN - ", "EN: ", "EN| ", "EN 4K: ". The code must be upper case in the title. */
const PREFIX = /^([[(|])?\s*([A-Z]{2,3}(?:-[A-Z]{2})?)(\s+4K)?\s*[\])|:\-–—]+\s*/;
/** "4K-EN ", "4K EN: ". */
const PREFIX_4K = /^4K[-\s]+([A-Z]{2,3}(?:-[A-Z]{2})?)\s*[\])|:\-–—]*\s+/;

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const word = (alts: string) => new RegExp(`${B}(?:${alts})${E}`, 'giu');

const QUALITY_TOKENS: [RegExp, number][] = [
  [word('4k|8k|uhd|2160p|3840p'), 0],
  [word('fhd|full\\s?hd|1080[pi]'), 1],
  [word('hd|hq|720p'), 2],
  [word('sd|480p|576p|360p'), 3],
];
const TAG_ORDER = ['HDR', 'DV', 'HEVC', 'MULTI', 'SUB', 'DUB'] as const;
const TAG_TOKENS: [RegExp, (typeof TAG_ORDER)[number]][] = [
  [word('hdr10\\+|hdr10plus|hdr10|hdr'), 'HDR'],
  [word('dovi|dolby\\s?vision|dv'), 'DV'],
  [word('hevc|h\\.?265|x265'), 'HEVC'],
  [word('multi[-\\s]?(?:subs?|audio|lang)|multi|dual[-\\s]?audio|dual'), 'MULTI'],
  [word('vostfr|vose|vost|subbed|subs|sub'), 'SUB'],
  [word('dubbed|dub'), 'DUB'],
];
/** Removed but not recorded. */
const DROP_TOKENS = word('av1|x264|h\\.?264|avc|[2-6]0\\s?fps');

const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;
const BARS = /[┃│｜❘]/g;
const EMPTY_BRACKETS = /[[(][\s|,+/\-–—]*[\])]/g;
const EDGES = /^[\s\-–—|:.,+/]+|[\s\-–—|:,+/]+$/g;
const YEAR_BRACKETED = /[([]\s*((?:19|20)\d{2})\s*[)\]]/g;
const YEAR_TRAILING = /(?:\s[-–—]\s*|\s)((?:19|20)\d{2})\s*$/;
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };
const ROMAN_WORD = /(?<=^| )(?:ii|iii|iv|v|vi|vii|viii|ix)(?= |$)/g;

function prepare(s: string): string {
  return s.normalize('NFKC').replace(INVISIBLE, '').replace(BARS, '|').trim();
}

function tidy(s: string): string {
  let out = s;
  for (let prev = ''; prev !== out;) {
    prev = out;
    out = out.replace(EMPTY_BRACKETS, ' ').replace(/\s+/g, ' ').replace(EDGES, '');
  }
  return out.trim();
}

/** Peels one leading language prefix: the language and the rest, or undefined. */
function peelPrefix(s: string): { lang: string; rest: string; quality?: number } | undefined {
  const four = PREFIX_4K.exec(s);
  if (four) {
    const lang = LANG_CODES[four[1]!];
    if (lang) return { lang, rest: s.slice(four[0].length), quality: 0 };
  }
  const m = PREFIX.exec(s);
  if (!m) return undefined;
  const lang = LANG_CODES[m[2]!];
  if (!lang) return undefined;
  return m[3] ? { lang, rest: s.slice(m[0].length), quality: 0 } : { lang, rest: s.slice(m[0].length) };
}

function stripTags(s: string): { rest: string; quality: number; tags: string[] } {
  let quality = QUALITY_UNKNOWN;
  const found = new Set<string>();
  let rest = s;
  // Tags first: "hdr10" must go before "hd" can match inside nothing (whole words only, but order keeps it simple).
  for (const [re, tag] of TAG_TOKENS) {
    rest = rest.replace(re, () => {
      found.add(tag);
      return ' ';
    });
  }
  for (const [re, rank] of QUALITY_TOKENS) {
    rest = rest.replace(re, () => {
      quality = Math.min(quality, rank);
      return ' ';
    });
  }
  rest = rest.replace(DROP_TOKENS, ' ');
  return { rest, quality, tags: TAG_ORDER.filter((t) => found.has(t)) };
}

function takeYear(s: string): { rest: string; year?: number } {
  const max = new Date().getFullYear() + 1;
  const ok = (y: number) => y >= 1900 && y <= max;
  let last: RegExpExecArray | undefined;
  for (const m of s.matchAll(YEAR_BRACKETED)) if (ok(Number(m[1]))) last = m;
  if (last) {
    const rest = s.slice(0, last.index) + ' ' + s.slice(last.index! + last[0].length);
    if (tidy(rest)) return { rest, year: Number(last[1]) };
  }
  const t = YEAR_TRAILING.exec(s.trimEnd());
  if (t && ok(Number(t[1]))) {
    const rest = s.trimEnd().slice(0, t.index);
    if (tidy(rest)) return { rest, year: Number(t[1]) };
  }
  return { rest: s };
}

function baseOf(display: string): string {
  return searchKey(display.replace(/&/g, ' and ')).replace(ROMAN_WORD, (r) => ROMAN[r]!);
}

/** The language of a leading prefix of `name`, if any (a category name such as "SE | Action"). */
function prefixLang(name: string): string | undefined {
  return peelPrefix(prepare(name))?.lang;
}

export function parseVodTitle(title: string, categoryName?: string): ParsedTitle {
  const raw = prepare(title);
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
