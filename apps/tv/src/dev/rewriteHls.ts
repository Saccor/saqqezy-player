// Pure helpers for the dev proxy (apps/tv/vite.proxy.ts). No Node or DOM APIs, so they are unit-testable.

export const RAW_PATH = '/__proxy/raw';
export const HLS_PATH = '/__proxy/hls';

/** `/__proxy/hls/<file name>?u=<url>`. The file name is cosmetic (only `u` is read) but native HLS sniffs it. */
export function hlsProxyPath(abs: string): string {
  let name = '';
  try {
    name = new URL(abs).pathname.split('/').pop() ?? '';
  } catch {
    // keep empty
  }
  return `${HLS_PATH}${name ? `/${encodeURIComponent(name)}` : ''}?u=${encodeURIComponent(abs)}`;
}

const wrapUri = (uri: string, base: string): string => {
  let abs: URL;
  try {
    abs = new URL(uri, base);
  } catch {
    return uri;
  }
  // data:, skd: (FairPlay) and anything else that is not fetchable over http(s) stays as it is.
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return uri;
  return hlsProxyPath(abs.toString());
};

/**
 * Rewrites an HLS playlist so every segment / key / variant URI is an absolute URI through the hls proxy route.
 * Anything that is not an HLS playlist (no `#EXT-X-` tag, e.g. a plain M3U channel list) is returned unchanged.
 */
export function rewriteHls(text: string, base: string): string {
  if (!text.includes('#EXT-X-')) return text;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (t === '') return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${wrapUri(uri, base)}"`);
      return wrapUri(t, base);
    })
    .join('\n');
}
