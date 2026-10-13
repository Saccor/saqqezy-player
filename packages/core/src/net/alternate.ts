const LIVE_PATH = /^\/live\/[^/]+\/[^/]+\/[^/]+\.(ts|m3u8)$/;

/** Xtream live URLs: the same stream with the other container extension; otherwise undefined. */
export function alternateStreamUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const m = LIVE_PATH.exec(parsed.pathname);
  if (!m) return undefined;
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? '' : url.slice(cut);
  const swapped = m[1] === 'ts'
    ? base.replace(/\.ts$/, '.m3u8')
    : base.replace(/\.m3u8$/, '.ts');
  return swapped === base ? undefined : swapped + rest;
}
