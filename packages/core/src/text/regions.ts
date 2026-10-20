import { UNCATEGORIZED } from '../constants.ts';
import type { Channel } from '../types.ts';
import { LANG_CODES, peelPrefix, prepare } from './nameTags.ts';

/**
 * Region detection for provider groups (report 2026-10-20 §2.3): which countries or languages a group of the user's
 * own playlist is for, from closed tables only. Pure; run at ingest and cached with `REGION_DETECTOR_VERSION` next to
 * the channels, so a cold start never runs it. The tables are metadata (codes, English labels, default languages),
 * never content: no channel, broadcaster or league names.
 */

/** Bump whenever a rule or table changes: cached results of another version are rebuilt (after first paint). */
export const REGION_DETECTOR_VERSION = 1;
/** Results below this are "Not sure": shown in the picker, never used to hide or reorder a group. */
export const REGION_SURE = 0.6;

export type RegionVia = 'user' | 'tvg' | 'flag' | 'code' | 'name' | 'region' | 'members' | 'trailing';

/** One group's region. `countries`: ISO 3166-1 alpha-2 (GB, not UK). `langs`: ISO 639-1, most likely first. */
export interface GroupRegion {
  countries: string[];
  langs: string[];
  conf: number;
  via: RegionVia;
}

/** `tvg-country` / `tvg-language` counts over a group's members (M3U ingest; not stored on `Channel`). */
export interface TvgTally {
  members: number;
  withCountry: number;
  country: Record<string, number>;
  withLanguage: number;
  language: Record<string, number>;
}

export interface RegionGroupInput {
  id: string;
  /** The provider's group name. */
  name: string;
  /** Member channel names (playlist names), for the member vote. */
  members?: readonly string[];
  tvg?: TvgTally;
}

// ---------- tables ----------

/** [code, English label, default languages, other names (English or native, any case)]. Closed on purpose. */
const COUNTRIES: [string, string, string[], string[]][] = [
  ['SE', 'Sweden', ['sv'], ['Sverige', 'Swedish', 'Svenska']],
  ['NO', 'Norway', ['no'], ['Norge', 'Noreg', 'Norwegian', 'Norsk']],
  ['DK', 'Denmark', ['da'], ['Danmark', 'Danish', 'Dansk']],
  ['FI', 'Finland', ['fi'], ['Suomi', 'Finnish']],
  ['IS', 'Iceland', ['is'], ['Island', 'Icelandic']],
  ['DE', 'Germany', ['de'], ['Deutschland', 'German', 'Deutsch']],
  ['AT', 'Austria', ['de'], ['Osterreich', 'Austrian']],
  ['CH', 'Switzerland', ['de', 'fr', 'it'], ['Schweiz', 'Suisse', 'Svizzera', 'Swiss']],
  ['FR', 'France', ['fr'], ['French', 'Francais']],
  ['BE', 'Belgium', ['nl', 'fr'], ['Belgique', 'Belgie', 'Belgian']],
  ['NL', 'Netherlands', ['nl'], ['Nederland', 'Holland', 'Dutch']],
  ['LU', 'Luxembourg', ['fr', 'de'], ['Luxemburg']],
  ['GB', 'United Kingdom', ['en'], ['United Kingdom', 'Great Britain', 'Britain', 'British', 'England', 'Scotland', 'Wales']],
  ['IE', 'Ireland', ['en'], ['Eire', 'Irish']],
  ['US', 'United States', ['en'], ['United States', 'America', 'American']],
  ['CA', 'Canada', ['en', 'fr'], ['Canadian']],
  ['AU', 'Australia', ['en'], ['Australian']],
  ['NZ', 'New Zealand', ['en'], ['New Zealand']],
  ['ES', 'Spain', ['es'], ['Espana']],
  ['PT', 'Portugal', ['pt'], ['Portuguese', 'Portugues']],
  ['IT', 'Italy', ['it'], ['Italia', 'Italian', 'Italiano']],
  ['GR', 'Greece', ['el'], ['Hellas', 'Ellada', 'Greek']],
  ['CY', 'Cyprus', ['el'], ['Cypriot']],
  ['PL', 'Poland', ['pl'], ['Polska', 'Polish', 'Polski']],
  ['CZ', 'Czechia', ['cs'], ['Czech Republic', 'Cesko', 'Czech']],
  ['SK', 'Slovakia', ['sk'], ['Slovensko', 'Slovak']],
  ['HU', 'Hungary', ['hu'], ['Magyarorszag', 'Hungarian', 'Magyar']],
  ['RO', 'Romania', ['ro'], ['Romanian']],
  ['BG', 'Bulgaria', ['bg'], ['Bulgarian']],
  ['RS', 'Serbia', ['sr'], ['Srbija', 'Serbian']],
  ['HR', 'Croatia', ['hr'], ['Hrvatska', 'Croatian']],
  ['BA', 'Bosnia and Herzegovina', ['bs'], ['Bosnia']],
  ['SI', 'Slovenia', ['sl'], ['Slovenija', 'Slovenian']],
  ['MK', 'North Macedonia', ['mk'], ['Macedonia', 'Macedonian']],
  ['ME', 'Montenegro', ['sr'], ['Crna Gora']],
  ['AL', 'Albania', ['sq'], ['Shqiperia', 'Albanian']],
  ['EE', 'Estonia', ['et'], ['Eesti', 'Estonian']],
  ['LV', 'Latvia', ['lv'], ['Latvija', 'Latvian']],
  ['LT', 'Lithuania', ['lt'], ['Lietuva', 'Lithuanian']],
  ['UA', 'Ukraine', ['uk'], ['Ukraina', 'Ukrainian']],
  ['RU', 'Russia', ['ru'], ['Rossiya', 'Russian']],
  ['TR', 'Turkey', ['tr'], ['Turkiye', 'Turkish']],
  ['IL', 'Israel', ['he'], ['Israeli']],
  ['IR', 'Iran', ['fa'], ['Persian']],
  ['AF', 'Afghanistan', ['fa'], ['Afghan']],
  ['SA', 'Saudi Arabia', ['ar'], ['Saudi Arabia', 'Saudi']],
  ['AE', 'United Arab Emirates', ['ar'], ['Emirates']],
  ['EG', 'Egypt', ['ar'], ['Egyptian']],
  ['MA', 'Morocco', ['ar', 'fr'], ['Maroc', 'Moroccan']],
  ['DZ', 'Algeria', ['ar', 'fr'], ['Algerie', 'Algerian']],
  ['TN', 'Tunisia', ['ar', 'fr'], ['Tunisie', 'Tunisian']],
  ['IQ', 'Iraq', ['ar'], ['Iraqi']],
  ['LB', 'Lebanon', ['ar'], ['Liban', 'Lebanese']],
  ['QA', 'Qatar', ['ar'], []],
  ['KW', 'Kuwait', ['ar'], []],
  ['JO', 'Jordan', ['ar'], []],
  ['IN', 'India', ['hi', 'en'], ['Bharat']],
  ['PK', 'Pakistan', ['ur'], ['Pakistani']],
  ['BD', 'Bangladesh', ['bn'], []],
  ['LK', 'Sri Lanka', ['si'], ['Sri Lanka']],
  ['CN', 'China', ['zh'], ['Chinese']],
  ['HK', 'Hong Kong', ['zh'], ['Hong Kong']],
  ['TW', 'Taiwan', ['zh'], []],
  ['JP', 'Japan', ['ja'], ['Nippon', 'Japanese']],
  ['KR', 'South Korea', ['ko'], ['South Korea', 'Korea', 'Korean']],
  ['TH', 'Thailand', ['th'], ['Thai']],
  ['VN', 'Vietnam', ['vi'], ['Viet Nam', 'Vietnamese']],
  ['MY', 'Malaysia', ['ms'], []],
  ['ID', 'Indonesia', ['id'], ['Indonesian']],
  ['PH', 'Philippines', ['en'], ['Pilipinas', 'Filipino']],
  ['MX', 'Mexico', ['es'], ['Mexican']],
  ['AR', 'Argentina', ['es'], ['Argentine', 'Argentinian']],
  ['BR', 'Brazil', ['pt'], ['Brasil', 'Brazilian']],
  ['CO', 'Colombia', ['es'], ['Colombian']],
  ['CL', 'Chile', ['es'], ['Chilean']],
  ['PE', 'Peru', ['es'], ['Peruvian']],
  ['VE', 'Venezuela', ['es'], []],
  ['ZA', 'South Africa', ['en'], ['South Africa']],
  ['NG', 'Nigeria', ['en'], ['Nigerian']],
  ['KE', 'Kenya', ['en'], []],
];

/** Codes that are also common words or language codes: they count only under the strict rules of §2.3. */
const AMBIGUOUS: ReadonlySet<string> = new Set(['IN', 'NO', 'IT', 'AR', 'UK', 'CA', 'AL', 'MY', 'ID']);

/** Alpha-3 and other spellings playlists use for a country. */
const ALIASES: Record<string, string> = {
  UK: 'GB', GBR: 'GB', USA: 'US', SWE: 'SE', NOR: 'NO', DEN: 'DK', DNK: 'DK', FIN: 'FI', GER: 'DE', DEU: 'DE',
  AUT: 'AT', SUI: 'CH', CHE: 'CH', FRA: 'FR', BEL: 'BE', NLD: 'NL', HOL: 'NL', ESP: 'ES', POR: 'PT', PRT: 'PT',
  ITA: 'IT', GRE: 'GR', GRC: 'GR', POL: 'PL', CZE: 'CZ', HUN: 'HU', ROU: 'RO', ROM: 'RO', BUL: 'BG', BGR: 'BG',
  SRB: 'RS', CRO: 'HR', HRV: 'HR', ALB: 'AL', UKR: 'UA', RUS: 'RU', TUR: 'TR', ISR: 'IL', IRN: 'IR', IND: 'IN',
  PAK: 'PK', CHN: 'CN', JPN: 'JP', KOR: 'KR', THA: 'TH', MEX: 'MX', ARG: 'AR', BRA: 'BR', CAN: 'CA', AUS: 'AU',
};

/** English labels of language-only keys (`lang:xx`). */
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English', es: 'Spanish', ar: 'Arabic', fr: 'French', pt: 'Portuguese', de: 'German', sv: 'Swedish',
  da: 'Danish', no: 'Norwegian', fi: 'Finnish', it: 'Italian', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', el: 'Greek',
  he: 'Hebrew', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', uk: 'Ukrainian',
  fa: 'Persian', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian',
};

/** Whole names of a language spoken in many countries: a language-only group, not a country. */
const LANGUAGE_NAMES: Record<string, string> = {
  ENGLISH: 'en', SPANISH: 'es', ESPANOL: 'es', LATINO: 'es', ARABIC: 'ar', ARAB: 'ar',
};

/** Multi-country region words → their set (or a language). */
const REGION_WORDS: Record<string, string[]> = {
  NORDIC: ['SE', 'NO', 'DK', 'FI', 'IS'], NORDICS: ['SE', 'NO', 'DK', 'FI', 'IS'], NORDEN: ['SE', 'NO', 'DK', 'FI', 'IS'],
  SCANDINAVIA: ['SE', 'NO', 'DK'], SCANDINAVIAN: ['SE', 'NO', 'DK'],
  BENELUX: ['BE', 'NL', 'LU'],
  BALKAN: ['RS', 'HR', 'BA', 'SI', 'MK', 'ME'], BALKANS: ['RS', 'HR', 'BA', 'SI', 'MK', 'ME'],
  EXYU: ['RS', 'HR', 'BA', 'SI', 'MK', 'ME'], 'EX YU': ['RS', 'HR', 'BA', 'SI', 'MK', 'ME'],
  LATAM: ['lang:es'], 'LATIN AMERICA': ['lang:es'],
};

const LABELS = new Map<string, string>();
const LANGS = new Map<string, string[]>();
/** Folded name (upper case, no accents, single spaces) → country code or `lang:xx`. */
const NAMES = new Map<string, string>();
for (const [code, label, langs, names] of COUNTRIES) {
  LABELS.set(code, label);
  LANGS.set(code, langs);
  for (const n of [label, ...names]) NAMES.set(fold(n), code);
}
for (const [n, lang] of Object.entries(LANGUAGE_NAMES)) NAMES.set(n, `lang:${lang}`);
/** Longest name in words, so the scan tries 1..n-word windows. */
const MAX_NAME_WORDS = Math.max(...[...NAMES.keys(), ...Object.keys(REGION_WORDS)].map((n) => n.split(' ').length));

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A country code as ISO alpha-2 ("UK" → "GB", "SWE" → "SE"), or undefined when it is not in the closed table. */
export function normalizeCountry(code: string): string | undefined {
  const up = code.trim().toUpperCase();
  const c = ALIASES[up] ?? up;
  return LABELS.has(c) ? c : undefined;
}

/** English label of a country code or a `lang:xx` key (no `Intl.DisplayNames`: Chromium 76 lacks it). */
export function countryLabel(key: string): string {
  if (key.startsWith('lang:')) return LANGUAGE_LABELS[key.slice(5)] ?? key.slice(5);
  return LABELS.get(key) ?? key;
}

/** A country's default languages (SE → sv), most spoken first; [] for an unknown code. */
export function countryLanguages(code: string): string[] {
  return [...(LANGS.get(code) ?? [])];
}

/** Every country code of the closed table, in table order. */
export function knownCountries(): string[] {
  return COUNTRIES.map((c) => c[0]);
}

/** The keys a region rule compares: its countries, else `lang:xx` for each language. */
export function regionKeys(r: GroupRegion): string[] {
  return r.countries.length ? r.countries : r.langs.map((l) => `lang:${l}`);
}

export function isSure(r: GroupRegion): boolean {
  return r.conf >= REGION_SURE - 1e-9;
}

// ---------- input building ----------

/** `tvg-country` / `tvg-language` tallies per group id (`g:<group-title>`) from parsed M3U entries. */
export function tallyTvg(entries: readonly { groupTitle?: string; tvgCountry?: readonly string[]; tvgLanguage?: readonly string[] }[]): Record<string, TvgTally> {
  const out: Record<string, TvgTally> = {};
  for (const e of entries) {
    const gid = `g:${e.groupTitle ?? UNCATEGORIZED}`;
    let t = out[gid];
    if (!t) out[gid] = t = { members: 0, withCountry: 0, country: {}, withLanguage: 0, language: {} };
    t.members++;
    if (e.tvgCountry?.length) {
      t.withCountry++;
      const seen = new Set<string>();
      for (const raw of e.tvgCountry) {
        const c = normalizeCountry(raw);
        if (c && !seen.has(c)) { seen.add(c); t.country[c] = (t.country[c] ?? 0) + 1; }
      }
    }
    if (e.tvgLanguage?.length) {
      t.withLanguage++;
      const seen = new Set<string>();
      for (const raw of e.tvgLanguage) {
        const l = languageOf(raw);
        if (l && !seen.has(l)) { seen.add(l); t.language[l] = (t.language[l] ?? 0) + 1; }
      }
    }
  }
  return out;
}

/** "sv", "SWE", "Swedish" → "sv". */
function languageOf(raw: string): string | undefined {
  const t = raw.trim();
  if (/^[a-z]{2}$/.test(t)) return t;
  const code = LANG_CODES[t.toUpperCase()];
  if (code && !LABELS.has(t.toUpperCase())) return code;
  const f = fold(t);
  for (const [l, label] of Object.entries(LANGUAGE_LABELS)) if (fold(label) === f) return l;
  return undefined;
}

/** Groups of a channel list in first-appearance order, with member names and tallies. */
export function regionInputs(channels: readonly Channel[], tvg?: Readonly<Record<string, TvgTally>>): RegionGroupInput[] {
  const byId = new Map<string, { id: string; name: string; members: string[]; tvg?: TvgTally }>();
  for (const c of channels) {
    const id = `g:${c.group}`;
    let g = byId.get(id);
    if (!g) {
      g = { id, name: c.group, members: [] };
      const t = tvg?.[id];
      if (t) g.tvg = t;
      byId.set(id, g);
    }
    g.members.push(c.name);
  }
  return [...byId.values()];
}

// ---------- detection ----------

type Sep = '|' | ':' | '-' | '[' | '(' | ' ';
/** "SE | News", "[SE] Kids", "SE: Docs", "|SE| News", "(SE) News", "SE - News": the code and its separator. */
const LEADING = /^([[(|])?\s*([A-Z]{2,3})\s*([\])|:\-–—])/;
const LEADING_SPACE = /^([A-Z]{2,3})\s+[\p{L}\p{N}]/u;
const TRAILING = /[\s|:\-–—([]+([A-Z]{2,3})[\])]?\s*$/;
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

function sepOf(open: string | undefined, close: string): Sep {
  if (open === '[' || close === ']') return '[';
  if (open === '(' || close === ')') return '(';
  if (open === '|' || close === '|') return '|';
  if (close === ':') return ':';
  return '-';
}

/** A code as a region key: a country (alpha-2) or `lang:xx`; undefined when it is neither. */
function codeKey(code: string): string | undefined {
  const c = normalizeCountry(code);
  if (c) return c;
  const lang = LANG_CODES[code];
  return lang ? `lang:${lang}` : undefined;
}

function leading(name: string): { code: string; sep: Sep } | undefined {
  const m = LEADING.exec(name);
  if (m) return codeKey(m[2]!) ? { code: m[2]!, sep: sepOf(m[1], m[3]!) } : undefined;
  const s = LEADING_SPACE.exec(name);
  return s && codeKey(s[1]!) ? { code: s[1]!, sep: ' ' } : undefined;
}

/** Region from keys (countries and `lang:xx`); languages: explicit ones first, then the countries' defaults. */
function regionOf(keys: readonly string[], conf: number, via: RegionVia, langs: readonly string[] = []): GroupRegion {
  const countries: string[] = [];
  const out: string[] = [...langs];
  for (const k of keys) {
    if (k.startsWith('lang:')) {
      const l = k.slice(5);
      if (!out.includes(l)) out.push(l);
    } else if (!countries.includes(k)) countries.push(k);
  }
  for (const c of countries) for (const l of LANGS.get(c) ?? []) if (!out.includes(l)) out.push(l);
  return { countries, langs: out, conf: Math.round(conf * 100) / 100, via };
}

/** Codes held by at least half of the carriers. */
function majority(counts: Record<string, number>, carriers: number): string[] {
  return Object.keys(counts).filter((k) => counts[k]! * 2 >= carriers).sort((a, b) => counts[b]! - counts[a]!);
}

function fromTvg(t: TvgTally | undefined): GroupRegion | undefined {
  if (!t || t.members === 0 || t.withCountry * 2 < t.members) return undefined;
  const countries = majority(t.country, t.withCountry);
  if (!countries.length) return undefined;
  const langs = t.withLanguage * 2 >= t.members ? majority(t.language, t.withLanguage) : [];
  return regionOf(countries, 0.9, 'tvg', langs);
}

function fromFlags(name: string): GroupRegion | undefined {
  if (!name.includes('\u{1F1E6}'.slice(0, 1))) return undefined;
  const keys: string[] = [];
  for (const m of name.matchAll(FLAG)) {
    const [a, b] = [...m[0]];
    const code = String.fromCharCode(a!.codePointAt(0)! - 0x1f1e6 + 65, b!.codePointAt(0)! - 0x1f1e6 + 65);
    const c = normalizeCountry(code);
    if (c) keys.push(c);
  }
  return keys.length ? regionOf(keys, 0.9, 'flag') : undefined;
}

/** Whole country names and region words, any position: 1..n-word windows over the folded name. */
function fromWords(name: string): GroupRegion | undefined {
  const words = fold(name).split(' ');
  const names: string[] = [];
  const regions: string[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(MAX_NAME_WORDS, words.length - i); n >= 1; n--) {
      const w = n === 1 ? words[i]! : words.slice(i, i + n).join(' ');
      const hit = NAMES.get(w);
      const region = REGION_WORDS[w];
      if (hit === undefined && !region) continue;
      if (hit !== undefined) names.push(hit);
      else regions.push(...region!);
      i += n - 1;
      break;
    }
  }
  if (names.length) return regionOf(names, 0.8, 'name');
  if (regions.length) return regionOf(regions, 0.7, 'region');
  return undefined;
}

function fromMembers(members: readonly string[] | undefined): GroupRegion | undefined {
  if (!members || members.length < 3) return undefined;
  const counts = new Map<string, number>();
  let best = '';
  let bestN = 0;
  for (const name of members) {
    const p = peelPrefix(prepare(name));
    if (!p) continue;
    const key = codeKey(p.code);
    if (!key) continue;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestN) { best = key; bestN = n; }
  }
  return bestN >= members.length * 0.6 ? regionOf([best], 0.7, 'members') : undefined;
}

function fromTrailing(name: string): GroupRegion | undefined {
  const m = TRAILING.exec(name);
  if (!m || AMBIGUOUS.has(m[1]!) || name.length === m[0].length) return undefined;
  const key = codeKey(m[1]!);
  return key ? regionOf([key], 0.5, 'trailing') : undefined;
}

/**
 * Detects every group's region (§2.3), strongest signal first: user override, `tvg-country` majority, flag emoji,
 * leading code (+0.1 following the source's dominant separator, -0.1 breaking it), country names, region words,
 * member vote, trailing code. Groups with no signal are absent from the result.
 */
export function detectRegions(
  groups: readonly RegionGroupInput[],
  overrides?: Readonly<Record<string, readonly string[]>>,
): Record<string, GroupRegion> {
  // Source style: the separator most groups write their leading code with.
  const leads: ({ code: string; sep: Sep } | undefined)[] = new Array(groups.length);
  const sepCount = new Map<Sep, number>();
  const codeCount = new Map<string, number>();
  let withCode = 0;
  for (let i = 0; i < groups.length; i++) {
    const l = leading(prepare(groups[i]!.name));
    leads[i] = l;
    if (!l) continue;
    withCode++;
    sepCount.set(l.sep, (sepCount.get(l.sep) ?? 0) + 1);
    codeCount.set(l.code, (codeCount.get(l.code) ?? 0) + 1);
  }
  let style: Sep | undefined;
  let styleN = 0;
  for (const [s, n] of sepCount) if (n > styleN) { style = s; styleN = n; }
  if (styleN < 2 || styleN * 2 < withCode) style = undefined;

  const out: Record<string, GroupRegion> = {};
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const user = overrides?.[g.id];
    if (user?.length) {
      out[g.id] = regionOf(user.map((k) => (k.startsWith('lang:') ? k : normalizeCountry(k) ?? '')).filter(Boolean), 1, 'user');
      continue;
    }
    const name = prepare(g.name);
    let best: GroupRegion | undefined;
    const offer = (r: GroupRegion | undefined) => { if (r && (!best || r.conf > best.conf)) best = r; };
    offer(fromTvg(g.tvg));
    offer(fromFlags(name));
    const l = leads[i];
    if (l) {
      const ambiguous = AMBIGUOUS.has(l.code);
      const ok = l.sep === ' '
        ? style === ' ' && !ambiguous
        : !ambiguous || (style !== undefined && l.sep === style && (codeCount.get(l.code) ?? 0) >= 2);
      if (ok) {
        const conf = (ambiguous ? 0.6 : 0.85) + (style === undefined ? 0 : l.sep === style ? 0.1 : -0.1);
        offer(regionOf([codeKey(l.code)!], conf, 'code'));
      }
    }
    if (!best || best.conf < 0.8) offer(fromWords(name));
    if (!best || best.conf < 0.7) offer(fromMembers(g.members));
    if (!best) offer(fromTrailing(name));
    if (best) out[g.id] = best;
  }
  return out;
}

// ---------- cache record ----------

/** Stored next to the channel snapshot (meta `regions:<sourceId>`): detection results plus the inputs ingest alone has. */
export interface RegionsRecord {
  v: number;
  groups: Record<string, GroupRegion>;
  /** M3U only: the `tvg-*` tallies, so a new detector version can rebuild without the playlist. */
  tvg?: Record<string, TvgTally>;
}

export const regionsKey = (sourceId: string): string => `regions:${sourceId}`;

export function buildRegionsRecord(channels: readonly Channel[], tvg?: Record<string, TvgTally>): RegionsRecord {
  const rec: RegionsRecord = { v: REGION_DETECTOR_VERSION, groups: detectRegions(regionInputs(channels, tvg)) };
  if (tvg && Object.keys(tvg).length) rec.tvg = tvg;
  return rec;
}

const VIAS: readonly string[] = ['user', 'tvg', 'flag', 'code', 'name', 'region', 'members', 'trailing'];
const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string' && s.length <= 8);
const counts = (x: unknown): x is Record<string, number> => isRec(x) && Object.values(x).every((n) => typeof n === 'number');

function isGroupRegion(x: unknown): x is GroupRegion {
  return isRec(x) && strs(x['countries']) && strs(x['langs']) && typeof x['conf'] === 'number'
    && typeof x['via'] === 'string' && VIAS.includes(x['via']);
}

function isTally(x: unknown): x is TvgTally {
  return isRec(x) && typeof x['members'] === 'number' && typeof x['withCountry'] === 'number'
    && typeof x['withLanguage'] === 'number' && counts(x['country']) && counts(x['language']);
}

/** A stored record, repaired (bad entries dropped); undefined when it is not one. Any version is returned. */
export function readRegionsRecord(x: unknown): RegionsRecord | undefined {
  if (!isRec(x) || typeof x['v'] !== 'number' || !isRec(x['groups'])) return undefined;
  const groups: Record<string, GroupRegion> = {};
  for (const [k, v] of Object.entries(x['groups'])) if (k !== '__proto__' && isGroupRegion(v)) groups[k] = v;
  const out: RegionsRecord = { v: x['v'], groups };
  if (isRec(x['tvg'])) {
    const tvg: Record<string, TvgTally> = {};
    for (const [k, v] of Object.entries(x['tvg'])) if (k !== '__proto__' && isTally(v)) tvg[k] = v;
    out.tvg = tvg;
  }
  return out;
}
