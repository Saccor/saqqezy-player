import { searchKey } from './searchKey.ts';

/**
 * Name parsing shared by catalogue titles (`vod/titleParse.ts`) and live channel names (`live/channelName.ts`):
 * leading language/country prefixes, quality and format tags, tidying and the folded match key.
 */

/** Quality rank of a name with no quality tag (0 = 4K/UHD, 1 = FHD, 2 = HD, 3 = SD). */
export const QUALITY_UNKNOWN = 4;
/** Badge per quality rank ('' for unknown). */
export const QUALITY_LABELS: readonly string[] = ['4K', 'FHD', 'HD', 'SD', ''];

/**
 * Upper-case prefix code → ISO 639-1. ISO 639-1 and 639-2 codes plus the country codes playlists use for a language.
 * Closed on purpose: a word not in here is never taken for a prefix ("UP - …" stays part of the title).
 */
export const LANG_CODES: Record<string, string> = {
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

/** `LANG_CODES` as a map: a code cut from a name is a fresh string, which a map hashes but an object key interns. */
const LANG_OF = new Map(Object.entries(LANG_CODES));

/** "|SE| ", "[EN] ", "(EN) ", "EN - ", "EN: ", "EN| ", "EN 4K: ". The code must be upper case in the title. */
const PREFIX = /^([[(|])?\s*([A-Z]{2,3}(?:-[A-Z]{2})?)(\s+4K)?\s*[\])|:\-–—]+\s*/;
/** "4K-EN ", "4K EN: ". */
const PREFIX_4K = /^4K[-\s]+([A-Z]{2,3}(?:-[A-Z]{2})?)\s*[\])|:\-–—]*\s+/;

const TAG_ORDER = ['HDR', 'DV', 'HEVC', 'MULTI', 'SUB', 'DUB'] as const;
type Tag = (typeof TAG_ORDER)[number];
/**
 * Every quality, tag and dropped token. A number is a quality rank, a string a tag, null a token removed but not
 * recorded. All are matched in one pass, as whole words: one alternation with one capture group per entry.
 */
const TOKENS: [string, number | Tag | null][] = [
  ['hdr10\\+|hdr10plus|hdr10|hdr', 'HDR'],
  ['dovi|dolby\\s?vision|dv', 'DV'],
  ['hevc|h\\.?265|x265', 'HEVC'],
  ['multi[-\\s]?(?:subs?|audio|lang)|multi|dual[-\\s]?audio|dual', 'MULTI'],
  ['vostfr|vose|vost|subbed|subs|sub', 'SUB'],
  ['dubbed|dub', 'DUB'],
  ['4k|8k|uhd|2160p|3840p', 0],
  ['fhd|full\\s?hd|1080[pi]', 1],
  ['hd|hq|720p', 2],
  ['sd|480p|576p|360p', 3],
  ['av1|x264|h\\.?264|avc|[2-6]0\\s?fps', null],
];
const TOKEN_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${TOKENS.map(([alts]) => `(${alts})`).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
/** The same tokens, for a yes/no check. */
export const HAS_TOKEN = new RegExp(TOKEN_RE.source, 'iu');
export const NO_TAGS: string[] = [];
// eslint-disable-next-line no-control-regex
const PLAIN = /^[\x20-\x7e]*$/;

const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;
const BARS = /[┃│｜❘]/g;
const EMPTY_BRACKETS = /[[(][\s|,+/\-–—]*[\])]/g;
const HAS_EMPTY_BRACKETS = /[[(][\s|,+/\-–—]*[\])]/;
const SPACES = /\s+/g;
/** Some letter or digit. */
export const HAS_TEXT = /[\p{L}\p{N}]/u;
const DOUBLE_SPACE = /\s\s|[^\S ]/;
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };
const ROMAN_WORD = /(?<=^| )(?:ii|iii|iv|v|vi|vii|viii|ix)(?= |$)/g;

export function prepare(s: string): string {
  // Plain ASCII (most titles) has nothing to normalise.
  if (PLAIN.test(s)) return s.trim();
  return s.normalize('NFKC').replace(INVISIBLE, '').replace(BARS, '|').trim();
}

/** `\s` in a JS regex. */
function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || (c > 127 && (c === 160 || c === 5760 || (c >= 8192 && c <= 8202)
    || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279));
}

/** `[\s\-–—|:,+/]`: what is trimmed from the end. */
function isTrailer(c: number): boolean {
  return c === 45 || c === 124 || c === 58 || c === 44 || c === 43 || c === 47 || c === 8211 || c === 8212 || isSpace(c);
}

/** Drops brackets left empty, trims separators from both ends (also "." at the start) and collapses spaces. */
export function tidy(s: string): string {
  let out = s;
  // "([ ])": the outer pair empties once the inner one goes. Trimming the ends or collapsing spaces never empties a pair.
  if (out.includes('(') || out.includes('[')) while (HAS_EMPTY_BRACKETS.test(out)) out = out.replace(EMPTY_BRACKETS, ' ');
  let from = 0;
  let to = out.length;
  while (from < to && (out.charCodeAt(from) === 46 || isTrailer(out.charCodeAt(from)))) from++;
  while (to > from && isTrailer(out.charCodeAt(to - 1))) to--;
  if (from > 0 || to < out.length) out = out.slice(from, to);
  if (DOUBLE_SPACE.test(out)) out = out.replace(SPACES, ' ');
  return out;
}

/** Peels one leading language prefix: its code as written ("SE"), its language, and the rest; or undefined. */
export function peelPrefix(s: string): { code: string; lang: string; rest: string; quality?: number } | undefined {
  const four = PREFIX_4K.exec(s);
  if (four) {
    const lang = LANG_OF.get(four[1]!);
    if (lang) return { code: four[1]!, lang, rest: s.slice(four[0].length), quality: 0 };
  }
  const m = PREFIX.exec(s);
  if (!m) return undefined;
  const lang = LANG_OF.get(m[2]!);
  if (!lang) return undefined;
  const out = { code: m[2]!, lang, rest: s.slice(m[0].length) };
  return m[3] ? { ...out, quality: 0 } : out;
}

export function stripTags(s: string): { rest: string; quality: number; tags: string[] } {
  let quality = QUALITY_UNKNOWN;
  /** Bit k: TAG_ORDER[k] was found. */
  let found = 0;
  let rest = '';
  let from = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(s); m; m = TOKEN_RE.exec(s)) {
    // m[k + 1] is entry k's capture: the one that matched says what the token is.
    for (let k = 0; k < TOKENS.length; k++) {
      if (m[k + 1] === undefined) continue;
      const what = TOKENS[k]![1];
      if (typeof what === 'number') quality = Math.min(quality, what);
      else if (what) found |= 1 << TAG_ORDER.indexOf(what);
      break;
    }
    rest += s.slice(from, m.index) + ' ';
    from = m.index + m[0].length;
  }
  rest = from === 0 ? s : rest + s.slice(from);
  return { rest, quality, tags: found ? TAG_ORDER.filter((_, k) => (found & (1 << k)) !== 0) : NO_TAGS };
}

const NOT_ALNUM = /[^a-z0-9]+/g;
/** Already a key: words of a-z and 0-9, one space apart. */
const KEY_SHAPED = /^[a-z0-9]+(?: [a-z0-9]+)*$/;
const MAYBE_ROMAN = /(?:^| )[iv]/;

function romanDigit(r: string): string {
  return ROMAN[r]!;
}

/** The folded match key of a display name: case and punctuation folded, "&" as "and", roman numerals as digits. */
export function baseOf(display: string): string {
  const s = display.includes('&') ? display.replace(/&/g, ' and ') : display;
  // Plain ASCII: what `searchKey` gives, without its Unicode passes.
  let key: string;
  if (PLAIN.test(s)) {
    key = s.toLowerCase();
    if (!KEY_SHAPED.test(key)) key = key.replace(NOT_ALNUM, ' ').trim();
  } else key = searchKey(s);
  return MAYBE_ROMAN.test(key) ? key.replace(ROMAN_WORD, romanDigit) : key;
}
