/**
 * Language tags as panels, playlists and engines write them (ISO 639-1, both ISO 639-2 forms, BCP 47 with a region or
 * script, or an English name) → ISO 639-1.
 */

/** ISO 639-1 → [ISO 639-2/T, ISO 639-2/B when it differs, English name]. */
const LANGS: Record<string, readonly string[]> = {
  af: ['afr', '', 'afrikaans'], am: ['amh', '', 'amharic'], ar: ['ara', '', 'arabic'], az: ['aze', '', 'azerbaijani'],
  be: ['bel', '', 'belarusian'], bg: ['bul', '', 'bulgarian'], bn: ['ben', '', 'bengali'], bs: ['bos', '', 'bosnian'],
  ca: ['cat', '', 'catalan'], cs: ['ces', 'cze', 'czech'], cy: ['cym', 'wel', 'welsh'], da: ['dan', '', 'danish'],
  de: ['deu', 'ger', 'german'], el: ['ell', 'gre', 'greek'], en: ['eng', '', 'english'], es: ['spa', '', 'spanish'],
  et: ['est', '', 'estonian'], eu: ['eus', 'baq', 'basque'], fa: ['fas', 'per', 'persian'], fi: ['fin', '', 'finnish'],
  fr: ['fra', 'fre', 'french'], ga: ['gle', '', 'irish'], gl: ['glg', '', 'galician'],
  gu: ['guj', '', 'gujarati'], he: ['heb', '', 'hebrew'], hi: ['hin', '', 'hindi'], hr: ['hrv', '', 'croatian'],
  hu: ['hun', '', 'hungarian'], hy: ['hye', 'arm', 'armenian'], id: ['ind', '', 'indonesian'], is: ['isl', 'ice', 'icelandic'],
  it: ['ita', '', 'italian'], ja: ['jpn', '', 'japanese'], ka: ['kat', 'geo', 'georgian'], kk: ['kaz', '', 'kazakh'],
  km: ['khm', '', 'khmer'], kn: ['kan', '', 'kannada'], ko: ['kor', '', 'korean'], ku: ['kur', '', 'kurdish'],
  lo: ['lao', '', 'lao'], lt: ['lit', '', 'lithuanian'], lv: ['lav', '', 'latvian'], mk: ['mkd', 'mac', 'macedonian'],
  ml: ['mal', '', 'malayalam'], mn: ['mon', '', 'mongolian'], mr: ['mar', '', 'marathi'], ms: ['msa', 'may', 'malay'],
  mt: ['mlt', '', 'maltese'], my: ['mya', 'bur', 'burmese'], nb: ['nob', '', 'norwegian bokmål'], ne: ['nep', '', 'nepali'],
  nl: ['nld', 'dut', 'dutch'], nn: ['nno', '', 'norwegian nynorsk'], no: ['nor', '', 'norwegian'], pa: ['pan', '', 'punjabi'],
  pl: ['pol', '', 'polish'], ps: ['pus', '', 'pashto'], pt: ['por', '', 'portuguese'], ro: ['ron', 'rum', 'romanian'],
  ru: ['rus', '', 'russian'], si: ['sin', '', 'sinhala'], sk: ['slk', 'slo', 'slovak'], sl: ['slv', '', 'slovenian'],
  so: ['som', '', 'somali'], sq: ['sqi', 'alb', 'albanian'], sr: ['srp', '', 'serbian'], sv: ['swe', '', 'swedish'],
  sw: ['swa', '', 'swahili'], ta: ['tam', '', 'tamil'], te: ['tel', '', 'telugu'], th: ['tha', '', 'thai'],
  tl: ['tgl', '', 'tagalog'], tr: ['tur', '', 'turkish'], uk: ['ukr', '', 'ukrainian'], ur: ['urd', '', 'urdu'],
  uz: ['uzb', '', 'uzbek'], vi: ['vie', '', 'vietnamese'], yi: ['yid', '', 'yiddish'], zh: ['zho', 'chi', 'chinese'],
  zu: ['zul', '', 'zulu'],
};

const LOOKUP = new Map<string, string>();
for (const [code, names] of Object.entries(LANGS)) {
  LOOKUP.set(code, code);
  for (const n of names) if (n) LOOKUP.set(n, code);
}

/**
 * The ISO 639-1 code of `tag`, or undefined when it names no single language: missing, undetermined (`und`), several
 * (`mul`), no speech (`zxx`), a private-use code (`qaa`) or anything not recognised.
 */
export function isoLanguage(tag: string | undefined): string | undefined {
  const t = tag?.trim().toLowerCase();
  if (!t) return undefined;
  return LOOKUP.get(t) ?? LOOKUP.get(t.split(/[-_]/)[0] ?? '');
}

/** The English name of a language tag `isoLanguage` recognises ("ice" → "Icelandic"); undefined otherwise. */
export function englishLanguageName(tag: string | undefined): string | undefined {
  const name = LANGS[isoLanguage(tag) ?? '']?.[2];
  return name?.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** Every ISO 639-1 code `isoLanguage` returns. */
export const ISO_LANGUAGES: readonly string[] = Object.keys(LANGS);
