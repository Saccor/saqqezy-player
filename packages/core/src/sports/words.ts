/**
 * Generic TV-guide words for match detection (design note live-matches-ranking §3.3). These are words a guide uses for
 * any programme ("replay", "highlights", "studio"), in a few languages, plus the generic sport-category vocabulary the
 * start-page spec approved (§5.2). Never competition, club, broadcaster or league names. All entries are folded
 * (lowercase, no accents; see `foldText`).
 */
import { foldText } from './match.ts';

/** Bits of `SportsCandidate.flags`. */
export const MATCH_FLAGS = {
  /** `<live/>` or a live title prefix or suffix. */
  live: 1,
  /** `<previously-shown/>`. */
  rerun: 2,
  replay: 4,
  highlights: 8,
  studio: 16,
  /** The sides were split on a weak separator (`-`, `x`, `@`). */
  weakSep: 32,
} as const;

/** Folded (lowercase, no accents). Generic sport words only; never competition or club names. */
export const SPORT_CATEGORIES: ReadonlySet<string> = new Set([
  'sport', 'sports', 'sports event', 'sporting event', 'football', 'soccer', 'fotboll', 'fussball', 'fußball', 'deportes',
  'futbol', 'calcio', 'ice hockey', 'ishockey', 'hockey', 'basketball', 'tennis', 'motorsport', 'handball', 'rugby',
  'cricket', 'boxing', 'mma', 'golf',
]);
/** The football words of `SPORT_CATEGORIES`: their category chip, when the guide writes one, is offered first. */
export const FOOTBALL_CATEGORIES: ReadonlySet<string> = new Set(['football', 'soccer', 'fotboll', 'fussball', 'fußball', 'futbol', 'calcio']);
/** Broad categories that say "sport", not which: never a chip. */
export const BROAD_SPORT_CATEGORIES: ReadonlySet<string> = new Set(['sport', 'sports', 'sports event', 'sporting event', 'deportes']);
/** Other generic category words that are never a competition. */
const GENERIC_EXTRA: ReadonlySet<string> = new Set(['live', 'direct', 'direkt', 'hd', 'uhd', '4k', 'sd', 'new', 'premiere']);
export const DVB_SPORT = /^0x4[0-9a-b]$/;
export const DVB_CODE = /^0x[0-9a-f]{1,2}$/;
export const DVB_MAGAZINE = '0x42';

/** Folded category text: a sport category or DVB sport code (the magazine code is not). */
export function isSportCategory(folded: string): boolean {
  return SPORT_CATEGORIES.has(folded) || (DVB_SPORT.test(folded) && folded !== DVB_MAGAZINE);
}

/** Folded category text that never names a competition (sport words, DVB codes, live, hd, …). */
export function isGenericCategory(folded: string): boolean {
  return SPORT_CATEGORIES.has(folded) || DVB_CODE.test(folded) || GENERIC_EXTRA.has(folded);
}

const REPLAY_WORDS = [
  // en
  'replay', 'rerun', 'repeat', 're-air', 'encore', 'delayed', 'full match', 'classic', 'rewind',
  // sv
  'repris',
  // de
  'wiederholung', 'wdh', 'aufzeichnung',
  // es
  'repeticion', 'diferido',
  // fr
  'rediffusion', 'differe',
  // it
  'replica', 'differita',
  // pt
  'reprise',
  // nl
  'herhaling',
];
/**
 * The words that mean a re-air even in a description. Looser words ("classic", "replay" as in a replayed tie,
 * "reprise", "delayed") stay title and sub-title only, so a live match's desc never hides it.
 */
const DESC_REPLAY_WORDS = [
  'rerun', 're-air', 'repris', 'wiederholung', 'wdh', 'aufzeichnung', 'repeticion', 'diferido', 'rediffusion',
  'herhaling', 'replica', 'differita',
];
const HIGHLIGHTS_WORDS = [
  'highlights', 'extended highlights', 'all the goals', 'goals', 'recap', 'review', 'best of',
  'hojdpunkter', 'sammandrag', 'mal',
  'zusammenfassung', 'tore',
  'resumen', 'goles', 'lo mejor',
  'resume', 'buts', 'temps forts',
  'sintesi', 'gol',
  'resumo', 'gols', 'melhores momentos',
  'samenvatting', 'doelpunten',
];
const STUDIO_WORDS = [
  'studio', 'build-up', 'pre-match', 'post-match', 'preview', 'countdown', 'reaction', 'analysis', 'magazine', 'show',
  'talk', 'news', 'kick-off show',
  'forsnack', 'eftersnack', 'magasin',
  'vorbericht', 'analyse', 'magazin',
  'previa', 'analisis', 'programa',
  'avant-match', 'apres-match',
  'prepartita', 'postpartita',
  'pre-jogo', 'pos-jogo',
  'voorbeschouwing', 'nabeschouwing',
];
/** Words that make a title piece a stage of a competition, not its name ("Round 12", "Group A", "Final"). */
const STAGE_WORDS = [
  'round', 'matchday', 'match day', 'week', 'leg', 'group', 'final', 'semi-final', 'quarter-final', 'play-off',
  'playoff', 'playoffs', 'qualifier', 'qualifying', 'day', 'game', 'heat', 'stage',
  'omgang', 'semifinal', 'kvartsfinal',
  'spieltag', 'runde', 'finale', 'halbfinale', 'viertelfinale',
  'jornada', 'cuartos',
  'journee', 'demi-finale',
  'giornata',
  'rodada',
  'speelronde',
];
/** Live markers as a suffix piece ("… - Live"). */
export const LIVE_WORDS: ReadonlySet<string> = new Set(['live', 'direkt', 'en vivo', 'en directo', 'en direct', 'ao vivo', 'diretta']);

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?').replace(/ /g, '\\s+');
/** Whole words or phrases; letters and digits around them break the match. Longest alternatives first. */
const wordsRe = (words: readonly string[], extra = '') =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${[...words].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}])${extra}`, 'u');

/** `(R)`, `(Wdh.)`, `[R]` and the like. */
const BRACKET_REPLAY = /[([](?:r|wdh\.?|rpt|rep)[)\]]/;
const REPLAY_RE = wordsRe(REPLAY_WORDS);
const DESC_REPLAY_RE = wordsRe(DESC_REPLAY_WORDS);
const HIGHLIGHTS_RE = wordsRe(HIGHLIGHTS_WORDS);
const STUDIO_RE = wordsRe(STUDIO_WORDS);
const STAGE_RE = new RegExp(`^(?:${[...STAGE_WORDS].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'u');

/** REPLAY / HIGHLIGHTS / STUDIO bits of folded title or sub-title text. */
export function tagFlags(folded: string): number {
  let f = 0;
  if (BRACKET_REPLAY.test(folded) || REPLAY_RE.test(folded)) f |= MATCH_FLAGS.replay;
  if (HIGHLIGHTS_RE.test(folded)) f |= MATCH_FLAGS.highlights;
  if (STUDIO_RE.test(folded)) f |= MATCH_FLAGS.studio;
  return f;
}

/** The REPLAY bit of a folded description slice (the strict word list only). */
export function descFlags(folded: string): number {
  return DESC_REPLAY_RE.test(folded) ? MATCH_FLAGS.replay : 0;
}

/** Folded piece that is a stage ("round 12", "group a", "final") or carries a number: not a competition name. */
export function isStage(folded: string): boolean {
  return /\d/.test(folded) || STAGE_RE.test(folded.trim());
}

/** Folded whole words that make a channel or folder name a sport channel's. Generic words only, in a few languages. */
const SPORT_NAME_WORDS: ReadonlySet<string> = new Set([
  'sport', 'sports', 'foot', 'football', 'soccer', 'fotboll', 'fodbold', 'fotball', 'fussball', 'fußball', 'voetbal',
  'futbol', 'futebol', 'calcio', 'deporte', 'deportes', 'esporte', 'esportes', 'desporto', 'league', 'liga', 'ligue',
]);
/** Everyday words that merely end in "sport". */
const NOT_SPORT_WORDS: ReadonlySet<string> = new Set(['passport', 'passports', 'transport', 'transports']);

/**
 * A channel's own name or its folder name says it shows sport: a generic sport word, or a word that starts or ends
 * with "sport" ("supersport", "sportv"). Guides that tag no sport category use this as the sport signal instead.
 */
export function isSportChannelName(name: string): boolean {
  for (const w of foldText(name).split(/[^\p{L}\p{N}]+/u)) {
    if (!w || NOT_SPORT_WORDS.has(w)) continue;
    if (SPORT_NAME_WORDS.has(w) || w.startsWith('sport') || w.endsWith('sport') || w.endsWith('sports')) return true;
  }
  return false;
}
