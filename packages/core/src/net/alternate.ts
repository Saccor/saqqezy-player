const LIVE_PATH = /^\/live\/[^/]+\/[^/]+\/[^/]+\.(ts|m3u8)$/;
/** Xtream short form `/{user}/{pass}/{id}` (MPEG-TS by default): exactly three segments, the last numeric. */
const SHORT_PATH = /^\/[^/]+\/[^/]+\/\d+$/;

/**
 * Xtream live URLs: the same stream with the other container extension; the short form maps to the HLS live
 * path (`/live/{user}/{pass}/{id}.m3u8`). Otherwise undefined.
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
  if (SHORT_PATH.test(parsed.pathname)) {
    return `${parsed.protocol}//${parsed.host}/live${parsed.pathname}.m3u8${rest}`;
  }
  const m = LIVE_PATH.exec(parsed.pathname);
  if (!m) return undefined;
  const swapped = m[1] === 'ts'
    ? base.replace(/\.ts$/, '.m3u8')
    : base.replace(/\.m3u8$/, '.ts');
  return swapped === base ? undefined : swapped + rest;
}
