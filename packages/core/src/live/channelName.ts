import { baseOf, HAS_TEXT, peelPrefix, prepare, QUALITY_UNKNOWN, stripTags, tidy } from '../text/nameTags.ts';

/** A live channel name split into the channel and what kind of stream of it this is. */
export interface ParsedChannelName {
  /** Prefix code as written, normalised by alias ("GB" → "UK", "USA" → "US"); undefined without a prefix. */
  country?: string;
  /** Name with the prefix, quality, codec and spare-feed tags removed, original casing ("Channel One"). */
  display: string;
  /** Match key: folded, punctuation-free; "+1" kept as "plus1"; East/West and all numbers kept. */
  base: string;
  /** 0 = 4K … 3 = SD, 4 = unknown (same ranks as VOD). */
  quality: number;
  /** Named as a spare feed at the end ("backup", "bkp", "alt", "reserve", "dead", optionally numbered). Not "VIP": that names its own channel. */
  backup: boolean;
}

const COUNTRY_ALIASES: Record<string, string> = { GB: 'UK', USA: 'US' };
/**
 * One spare-feed tag at the very end: "(backup 2)", "ALT", "[bkp]". "VIP" is not one: "Channel One VIP" is its own channel.
 * Only run on the last SPARE_SPAN characters of a tidied name (single spaces, no trailing separators), where the longest
 * tag fits: an end-anchored pattern over the whole name backtracks quadratically on a long separator run. The
 * separators before the tag are left to `tidy`.
 */
const SPARE_TAIL = /[[(]?\s*(?:backup|bkp|alt|reserve|dead)(?:\s*\d{1,2})?\s*[\])]?\s*$/i;
const SPARE_SPAN = 24;
/** "+1", "+ 2": a timeshift feed, a different channel. */
const TIMESHIFT = /(?<![\p{L}\p{N}])\+\s?(\d{1,2})(?!\p{N})/gu;

/** Where a spare-feed tag at the end of tidied `s` starts, or -1. */
function spareTail(s: string): number {
  const from = Math.max(0, s.length - SPARE_SPAN);
  const m = SPARE_TAIL.exec(from ? s.slice(from) : s);
  return m ? from + m.index : -1;
}

export function parseChannelName(name: string): ParsedChannelName {
  const raw = prepare(name);
  const peeled = peelPrefix(raw);
  const tagged = stripTags(peeled ? peeled.rest : raw);
  let rest = tidy(tagged.rest);
  let backup = false;
  // Spare-feed tags only at the end, so a name that starts with one ("Alt Rock TV") keeps it.
  for (let m = spareTail(rest); m !== -1; m = spareTail(rest)) {
    const left = rest.slice(0, m);
    if (!HAS_TEXT.test(left)) break;
    backup = true;
    rest = tidy(left);
  }
  const display = rest || raw;
  const out: ParsedChannelName = {
    display,
    base: baseOf(display.includes('+') ? display.replace(TIMESHIFT, ' plus$1 ') : display),
    quality: Math.min(tagged.quality, peeled?.quality ?? QUALITY_UNKNOWN),
    backup,
  };
  if (peeled) out.country = COUNTRY_ALIASES[peeled.code] ?? peeled.code;
  return out;
}
