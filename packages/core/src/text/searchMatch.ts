import { peelPrefix, prepare, stripTags, tidy } from './nameTags.ts';
import { searchKey } from './searchKey.ts';

/**
 * Word-based search matching for channel and folder names: every query word must appear, in any order, with
 * letters and digits split apart ("Kanal5" = "kanal 5") and a compact fallback ("cafemusik" finds "Café Musik").
 * Ranked so the name the user means comes first, whatever country prefix or quality tag the playlist adds.
 */

const LETTER_DIGIT = /(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu;

/** `searchKey`, with a space between a letter and a digit next to each other. */
export function matchKey(s: string): string {
  const k = searchKey(s);
  return /\p{N}/u.test(k) ? k.replace(LETTER_DIGIT, '$1$2 ') : k;
}

export interface CompiledQuery { key: string; words: string[]; compact: string }

/** The query's words; undefined when it has none. */
export function compileQuery(query: string): CompiledQuery | undefined {
  const key = matchKey(query);
  if (key === '') return undefined;
  return { key, words: key.split(' '), compact: key.replace(/ /g, '') };
}

/** A name's keys: the whole name, and the name without its country prefix and quality tags. */
export interface NameKeys { key: string; core: string; compact: string }

export function nameKeys(name: string): NameKeys {
  const key = matchKey(name);
  const prepared = prepare(name);
  const rest = peelPrefix(prepared)?.rest ?? prepared;
  const core = matchKey(tidy(stripTags(rest).rest)) || key;
  return { key, core, compact: key.replace(/ /g, '') };
}

export const NO_MATCH = Number.POSITIVE_INFINITY;

const atWordStart = (key: string, part: string): boolean => key.startsWith(part) || key.includes(` ${part}`);

/**
 * Lower is better: 0 the bare name is the query; 1 the bare name starts with it; 2 the query as a phrase at a word
 * start; 3 every word at a word start; 4 every word anywhere; 5 only the compact forms match; `NO_MATCH` otherwise.
 */
export function nameMatchScore(n: NameKeys, q: CompiledQuery): number {
  if (n.core === q.key) return 0;
  if (n.core.startsWith(q.key)) return 1;
  if (atWordStart(n.key, q.key)) return 2;
  if (q.words.every((w) => n.key.includes(w))) return q.words.every((w) => atWordStart(n.key, w)) ? 3 : 4;
  return n.compact.includes(q.compact) ? 5 : NO_MATCH;
}
