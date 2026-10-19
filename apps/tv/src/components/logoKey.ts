/**
 * The key a logo tile mounts its texture under: the logo URL, or undefined for the number/empty fallback. Keying
 * on the URL (never the row object) keeps the texture across refetches of the same channel, row re-use while
 * scrolling and chunk loads; a URL that failed for this tile, or one the cache knows as unusable, gets no texture.
 */
export function logoKey(url: string | undefined, failedUrl: string | undefined, usable: (url: string | undefined) => boolean): string | undefined {
  return url !== undefined && url !== failedUrl && usable(url) ? url : undefined;
}
