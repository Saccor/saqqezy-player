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
  /** Named as a spare feed ("backup", "bkp", "alt", "reserve", "vip", "dead", optionally numbered) at the end. */
  backup: boolean;
}

const COUNTRY_ALIASES: Record<string, string> = { GB: 'UK', USA: 'US' };
/** One spare-feed tag at the very end: "(backup 2)", "ALT", "[VIP]". */
const SPARE_TAIL = /[\s\-–—|:,]*[[(]?\s*(?:backup|bkp|alt|reserve|vip|dead)(?:\s*\d{1,2})?\s*[\])]?\s*$/i;
/** "+1", "+ 2": a timeshift feed, a different channel. */
const TIMESHIFT = /(?<![\p{L}\p{N}])\+\s?(\d{1,2})(?!\p{N})/gu;

export function parseChannelName(name: string): ParsedChannelName {
  const raw = prepare(name);
  const peeled = peelPrefix(raw);
  const tagged = stripTags(peeled ? peeled.rest : raw);
  let rest = tidy(tagged.rest);
  let backup = false;
  // Spare-feed tags only at the end, so a name that starts with one ("Alt Rock TV") keeps it.
  for (let m = SPARE_TAIL.exec(rest); m; m = SPARE_TAIL.exec(rest)) {
    const left = rest.slice(0, m.index);
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
