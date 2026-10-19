/** One version of a title, as the ordering sees it. */
export interface VersionCandidate {
  id: string;
  /** ISO 639-1, when detected. */
  lang?: string;
  /** Quality rank (0 = 4K … 4 = unknown). */
  quality: number;
  /** Last time the user watched this version (progress), if any. */
  activeAt?: number;
}

export interface VersionContext {
  /** The version the user picked for this title, if any. */
  pick?: string;
  /** Preferred languages, most preferred first. */
  langs: readonly string[];
}

/**
 * Versions best first; [0] is what Play plays. A version being watched (most recent first), then the remembered
 * pick, then the earliest preferred language, then versions with no detected language (often the original), then
 * other languages; best quality first within each. Ties keep list order.
 */
export function orderVersions<T extends VersionCandidate>(cands: readonly T[], ctx: VersionContext): T[] {
  const langRank = (c: T) => {
    const at = c.lang ? ctx.langs.indexOf(c.lang) : -1;
    if (at >= 0) return at;
    return c.lang ? ctx.langs.length + 1 : ctx.langs.length;
  };
  return cands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const aa = a.c.activeAt ?? -1;
      const ba = b.c.activeAt ?? -1;
      if (aa !== ba) return ba - aa;
      const ap = a.c.id === ctx.pick ? 0 : 1;
      const bp = b.c.id === ctx.pick ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return langRank(a.c) - langRank(b.c) || a.c.quality - b.c.quality || a.i - b.i;
    })
    .map((x) => x.c);
}

/** Locale languages written differently from ISO 639-1 in the app's lists. */
const LOCALE_ALIASES: Record<string, string> = { nb: 'no', nn: 'no', iw: 'he', in: 'id' };

/** The setting, or when it is empty the TV's language followed by English. */
export function preferredLanguages(setting: readonly string[], locale: string | undefined): string[] {
  if (setting.length) return [...setting];
  const raw = (locale ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  const tv = LOCALE_ALIASES[raw] ?? raw;
  return tv && tv !== 'en' ? [tv, 'en'] : ['en'];
}
