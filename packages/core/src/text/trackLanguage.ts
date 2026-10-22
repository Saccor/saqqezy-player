import { ISO_LANGUAGES, englishLanguageName, isoLanguage } from './language.ts';

/**
 * A track's language from what is written about it (spec 2026-10-22-track-languages): its label, a subtitle file's
 * name, or the subtitle text itself. All return ISO 639-1, or undefined rather than a guess.
 */

/** Lower case, accents and other combining marks removed ("Français" → "francais"). */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Native names (and a few other common ones) of languages, besides their English names. */
const OTHER_NAMES: Record<string, readonly string[]> = {
  ar: ['العربية', 'عربي'], bg: ['български'], ca: ['catala'], cs: ['cesky', 'cestina'], da: ['dansk'],
  de: ['deutsch'], el: ['ελληνικα'], es: ['espanol', 'castellano', 'latino'], et: ['eesti'], eu: ['euskara'],
  fa: ['فارسی', 'farsi'], fi: ['suomi'], fr: ['francais'], gl: ['galego'], he: ['עברית'], hi: ['हिन्दी', 'हिंदी'],
  hr: ['hrvatski'], hu: ['magyar'], id: ['indonesia'], is: ['islenska'], it: ['italiano'], ja: ['日本語'],
  ko: ['한국어'], lt: ['lietuviu'], lv: ['latviesu'], ms: ['melayu'], nl: ['nederlands', 'vlaams', 'flemish'],
  no: ['norsk', 'bokmal', 'nynorsk'], pl: ['polski'], pt: ['portugues', 'brasileiro', 'brazilian'], ro: ['romana'],
  ru: ['русский'], sk: ['slovencina'], sl: ['slovenscina'], sr: ['srpski', 'српски'], sv: ['svenska', 'svensk'],
  th: ['ไทย'], tr: ['turkce'], uk: ['українська'], zh: ['中文', '普通话', '国语', '國語', '粤语', 'mandarin', 'cantonese'],
};

/** Folded single-word language name → ISO 639-1. */
const NAMES = new Map<string, string>();
for (const code of ISO_LANGUAGES) {
  const name = englishLanguageName(code);
  if (name && !name.includes(' ')) NAMES.set(fold(name), code);
}
for (const [code, names] of Object.entries(OTHER_NAMES)) for (const n of names) NAMES.set(fold(n), code);

/**
 * Words in track labels that never name a language, though some are language codes ("HE-AAC", "HI" for hearing
 * impaired, "MA" in DTS-HD MA).
 */
const NOISE = new Set([
  'aac', 'ac', 'ac3', 'eac3', 'ec3', 'he', 'lc', 'dd', 'ddp', 'dts', 'hd', 'ma', 'x', 'es', 'mp2', 'mp3', 'opus', 'flac',
  'pcm', 'lpcm', 'truehd', 'atmos', 'dolby', 'digital', 'plus', 'stereo', 'mono', 'surround', 'ch', 'channel',
  'channels', 'sdh', 'cc', 'hi', 'hoh', 'forced', 'full', 'default', 'main', 'original', 'commentary', 'track', 'audio',
  'sound', 'sub', 'subs', 'subtitle', 'subtitles', 'songs', 'signs', 'lyrics', 'dub', 'dubbed', 'ad', 'descriptive',
  'description', 'kbps', 'khz', 'srt', 'ass', 'ssa', 'vtt', 'pgs', 'text', 'utf', 'and',
]);

/** A code with an optional BCP 47 region or script ("pt-BR", "es-419", "zh-Hant"); not "HE-AAC". */
const BARE_CODE = /^[a-z]{2,3}(?:[-_](?:[a-z]{2}|\d{3}|[a-z]{4}))?$/i;
const BRACKETED = /[[(|]\s*([a-z]{2,3})\s*[\])|]/gi;

/** A code word's language: letters only, 2 or 3 of them, not a noise word. */
function codeWord(w: string): string | undefined {
  if (!/^[a-z]{2,3}$/i.test(w) || NOISE.has(w.toLowerCase())) return undefined;
  return isoLanguage(w);
}

/** The first language name among `words` (folded). */
function nameIn(words: readonly string[]): string | undefined {
  for (const w of words) {
    const code = NAMES.get(w);
    if (code) return code;
  }
  return undefined;
}

const wordsOf = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The language a track's label names: a bare code ("SWE", "pt-BR"), a language's English or native name anywhere
 * ("Svenska 5.1", "English (SDH)"), a bracketed code ("[EN]"), or a code among words that never name a language
 * ("eng - AC3 stereo"). Undetermined codes and codec or flag words ("HE-AAC", "SDH HI") give nothing.
 */
export function languageFromLabel(label: string | undefined): string | undefined {
  const t = label?.trim();
  if (!t) return undefined;
  if (BARE_CODE.test(t)) return isoLanguage(t);
  const byName = nameIn(wordsOf(fold(t)));
  if (byName) return byName;
  for (const m of t.matchAll(BRACKETED)) {
    const code = codeWord(m[1]!);
    if (code) return code;
  }
  const words = wordsOf(t);
  const codes = new Set<string>();
  let other = false;
  let upper3: string | undefined;
  for (const w of words) {
    const code = codeWord(w);
    if (code) {
      codes.add(code);
      if (/^[A-Z]{3}$/.test(w)) upper3 ??= code;
    } else if (!/^\d+$/.test(w) && !NOISE.has(w.toLowerCase())) {
      other = true;
    }
  }
  if (codes.size !== 1) return undefined;
  // Among other words, only an upper-case ISO 639-2 code counts ("Director ENG", not "Director may comment").
  return other ? upper3 : [...codes][0];
}

/** Flags subtitle files carry next to their language code ("Film.en.forced.srt"). */
const FILE_FLAGS = new Set(['forced', 'sdh', 'hi', 'cc', 'default', 'full', 'normal']);

/**
 * The language a subtitle file's name gives: the last part before the extension as a code ("Film.2020.sv.srt",
 * "film_eng.forced.srt", "Film-pt-BR.srt"), else a language's name anywhere ("Film [Swedish].srt").
 */
export function languageFromFileName(name: string): string | undefined {
  const file = name.split(/[\\/]/).pop() ?? '';
  const base = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  const parts = base.split(/[.\-_\s[\]()]+/).filter(Boolean);
  let i = parts.length - 1;
  while (i > 0 && FILE_FLAGS.has(parts[i]!.toLowerCase())) i--;
  if (i > 0) {
    const last = parts[i]!;
    const code = codeWord(last);
    if (code) return code;
    // "pt-BR": a region after the code.
    if (/^[A-Z]{2}$/.test(last)) {
      const before = codeWord(parts[i - 1]!);
      if (before) return before;
    }
  }
  return nameIn(wordsOf(fold(base)));
}

// ---- text detection ----

type Script = 'latin' | 'cyrillic' | 'arabic' | 'hebrew' | 'greek' | 'thai' | 'devanagari' | 'hangul' | 'kana' | 'han';

function scriptOf(c: number): Script | undefined {
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7)) return 'latin';
  if (c >= 0x400 && c <= 0x4ff) return 'cyrillic';
  if ((c >= 0x600 && c <= 0x6ff && !(c >= 0x660 && c <= 0x66d) && c !== 0x60c && c !== 0x61b && c !== 0x61f) || (c >= 0x750 && c <= 0x77f)) return 'arabic';
  if (c >= 0x5d0 && c <= 0x5ea) return 'hebrew';
  if (c >= 0x370 && c <= 0x3ff) return 'greek';
  if (c >= 0xe01 && c <= 0xe5b) return 'thai';
  if (c >= 0x900 && c <= 0x97f) return 'devanagari';
  if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) return 'hangul';
  if (c >= 0x3041 && c <= 0x30ff && c !== 0x30fb && c !== 0x30fc) return 'kana';
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) return 'han';
  return undefined;
}

/** Common words of each Latin-script language, as subtitles write them (lower case, accents kept). */
const STOP_WORDS: Record<string, string> = {
  en: 'the and you to is it that of what are we have not do know this here now go be was for with me my your can on in about just he she they there don what\'s',
  sv: 'jag vet inte vad du om vi måste gå nu det är här och att en ett som på för med har han hon kan ska mig dig så men till av var när bara honom henne hur vill nej också säkert',
  da: 'jeg ved ikke hvad du om vi er nødt til at gå nu det her og en et som på for med har han hun kan skal mig dig så men af var når bare hvor hvorfor også sikkert',
  no: 'jeg vet ikke hva du om vi må gå nå det er her og en et som på for med har han hun kan skal meg deg så men til av var når bare hvor hvorfor også trygt',
  fi: 'ei ole en on ja se että mitä mutta kun niin jos tämä minä sinä hän me he nyt täällä tiedä missä mistä kanssa vain myös kyllä meidän täytyy pitää',
  de: 'ich nicht du wir ist es das die der und ein eine zu mit was wie hier jetzt müssen weiß sie er auf den dem mir dich mich ja nein aber auch noch schon sicher gehen',
  fr: 'je ne pas de quoi tu nous ce est ici le la les un une et il elle vous que qui dans pour avec mais sais on moi toi oui non sur maintenant devons',
  es: 'no sé de qué que es el la los las un una y en por para con pero lo me te se yo tú está eso esto muy sí del al nos ahora aquí tenemos estás',
  pt: 'não sei do que você está é o os as um uma e em de para com mas eu ele ela isso isto muito sim se me nós já tem agora aqui temos',
  it: 'non so di cosa è il lo la gli le un una e in per con ma che sono io tu mi ti ci questo quello molto sì del della ho hai ha adesso qui dobbiamo',
  nl: 'ik weet niet waar je het over hebt we moeten nu is hier de een en van dat die in op te met voor zijn maar wat ze hij jij mij ook er geen dit nog gaan',
  pl: 'nie jest się to że co jak ale tak ja ty mi mnie czy już tu tutaj wiem musimy bardzo może był była tego jestem dobrze tylko czym',
  tr: 've bir bu ne ben sen için ile ama çok var yok değil şimdi evet hayır şey gibi daha nasıl neden burada burası lazım mı mi',
  cs: 'je to že se na jsem jsi není nevím co jak ale tak ano ne tady teď musíme mě tě už jen být byl čem proč kde',
  hu: 'nem tudom hogy az egy és is van nincs mit mi most itt kell csak de már meg igen miért hol ez én te ha',
  ro: 'nu și să ce de la în cu pe mai este sunt ești știu acum aici trebuie despre dar da ei el ea eu tu ne vă cum unde foarte',
  id: 'aku kamu tidak ini itu yang dan di ke dari apa ada saya kita kami dengan untuk akan sudah bisa harus sekarang',
  vi: 'tôi không bạn là của và có này đó một những anh em được với cho đi phải bây giờ',
};
const STOP = new Map<string, string[]>();
for (const [lang, words] of Object.entries(STOP_WORDS)) {
  for (const w of words.split(' ')) {
    const list = STOP.get(w);
    if (list) list.push(lang);
    else STOP.set(w, [lang]);
  }
}

/** Letters only one Latin-script language (of those above) uses: a point each, at most `LETTER_CAP` per language. */
const LETTERS: Record<string, string> = {
  tr: 'şğı', pl: 'łąęśźżńć', cs: 'řěů', hu: 'őű', ro: 'țșăâî', de: 'ß', es: 'ñ¿¡', pt: 'ãõ', fr: 'œèêà', da: 'æø',
  vi: 'ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư',
};
const LETTER_LANG = new Map<string, string[]>();
for (const [lang, letters] of Object.entries(LETTERS)) {
  for (const ch of letters) {
    const list = LETTER_LANG.get(ch);
    if (list) list.push(lang);
    else LETTER_LANG.set(ch, [lang]);
  }
}
const LETTER_CAP = 3;

/** Latin-script text needs this many letters, and the winner this many points and this lead. */
const MIN_LATIN_LETTERS = 25;
const MIN_SCORE = 3;
const MIN_LEAD = 2;
/** Any other script needs this many letters. */
const MIN_SCRIPT_LETTERS = 6;

const MARKUP = /<[^>]*>|\{[^}]*\}|\[[^\]]*\]/g;

/**
 * The language subtitle text is written in, from a few cues: the script for non-Latin text (with the letters that
 * tell Ukrainian from Russian, Persian from Arabic, Japanese from Chinese), common words and distinctive letters for
 * Latin text. Undefined when there is too little text or no clear winner.
 */
export function detectTextLanguage(text: string): string | undefined {
  const clean = text.replace(MARKUP, ' ');
  const counts = new Map<Script, number>();
  let letters = 0;
  for (const ch of clean) {
    const s = scriptOf(ch.codePointAt(0)!);
    if (!s) continue;
    letters++;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (letters === 0) return undefined;
  const cjk = (counts.get('kana') ?? 0) + (counts.get('han') ?? 0);
  if (cjk >= MIN_SCRIPT_LETTERS && cjk * 2 >= letters) return (counts.get('kana') ?? 0) * 10 >= cjk ? 'ja' : 'zh';
  let top: Script | undefined;
  let topN = 0;
  for (const [s, n] of counts) if (n > topN) { top = s; topN = n; }
  if (!top || topN * 2 < letters) return undefined;
  if (top === 'latin') return topN >= MIN_LATIN_LETTERS ? latinLanguage(clean) : undefined;
  if (topN < MIN_SCRIPT_LETTERS) return undefined;
  const has = (re: RegExp) => (clean.match(re)?.length ?? 0) >= 2;
  switch (top) {
    case 'cyrillic': return has(/[іїєґ]/gi) ? 'uk' : has(/[ђћљњџј]/gi) ? 'sr' : 'ru';
    case 'arabic': return has(/[پچژگکی]/g) ? 'fa' : 'ar';
    case 'hebrew': return 'he';
    case 'greek': return 'el';
    case 'thai': return 'th';
    case 'devanagari': return 'hi';
    case 'hangul': return 'ko';
    default: return undefined;
  }
}

function latinLanguage(text: string): string | undefined {
  const score = new Map<string, number>();
  const add = (lang: string, n = 1) => score.set(lang, (score.get(lang) ?? 0) + n);
  for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (w.length < 2) continue;
    for (const lang of STOP.get(w) ?? []) add(lang);
  }
  const letterPoints = new Map<string, number>();
  for (const ch of text.toLowerCase()) {
    for (const lang of LETTER_LANG.get(ch) ?? []) letterPoints.set(lang, (letterPoints.get(lang) ?? 0) + 1);
  }
  for (const [lang, n] of letterPoints) add(lang, Math.min(n, LETTER_CAP));
  let best: string | undefined;
  let bestN = 0;
  let second = 0;
  for (const [lang, n] of score) {
    if (n > bestN) { second = bestN; best = lang; bestN = n; } else if (n > second) second = n;
  }
  return best && bestN >= MIN_SCORE && bestN - second >= MIN_LEAD ? best : undefined;
}
