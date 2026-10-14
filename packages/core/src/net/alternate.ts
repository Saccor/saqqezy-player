const LIVE_PATH = /^\/live\/[^/]+\/[^/]+\/[^/]+\.(ts|m3u8)$/;
/**
 * Xtream short form `/{user}/{pass}/{id}` (MPEG-TS by default): exactly three segments, the last a numeric id
 * with an optional `.ts` or `.m3u8` extension (a first segment of `live`, `movie` or `series` is the long form).
 */
const SHORT_PATH = /^(\/[^/]+\/[^/]+\/\d+)(?:\.(ts|m3u8))?$/;

/**
 * Xtream live URLs: the same stream with the other container extension. The short form maps to the canonical
 * live path in the other format: extensionless or `.ts` to `/live/{user}/{pass}/{id}.m3u8`, `.m3u8` to
 * `/live/{user}/{pass}/{id}.ts`. Otherwise undefined.
 */
export function alternateStreamUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? '' : url.slice(cut);
  const short = SHORT_PATH.exec(parsed.pathname);
  if (short && !/^\/(?:live|movie|series)\//.test(parsed.pathname)) {
    const ext = short[2] === 'm3u8' ? 'ts' : 'm3u8';
    return `${parsed.protocol}//${parsed.host}/live${short[1]}.${ext}${rest}`;
  }
  const m = LIVE_PATH.exec(parsed.pathname);
  if (!m) return undefined;
  const swapped = m[1] === 'ts'
    ? base.replace(/\.ts$/, '.m3u8')
    : base.replace(/\.m3u8$/, '.ts');
  return swapped === base ? undefined : swapped + rest;
}
