// Developer convenience for desktop browsers only; never shipped; TVs fetch directly.
//
// `GET /__proxy?u=<encodeURIComponent(url)>` (optionally `/__proxy/<file name>?u=...`) fetches `url` server-side inside `vite dev` and streams it back
// with `Access-Control-Allow-Origin: *`, so a desktop browser can reach providers that send no CORS headers.
// HLS playlists are rewritten so every segment / key / variant URI also goes through the proxy.
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export const PROXY_PATH = '/__proxy';

/**
 * `/__proxy/<file name>?u=<url>`. The file-name segment is cosmetic for the proxy (only `u` is read) but
 * native HLS players (e.g. desktop Chrome) sniff the URL extension of playlists and segments.
 */
export function proxiedPath(abs: string): string {
  let name = '';
  try {
    name = new URL(abs).pathname.split('/').pop() ?? '';
  } catch {
    // keep empty
  }
  return `${PROXY_PATH}${name ? `/${encodeURIComponent(name)}` : ''}?u=${encodeURIComponent(abs)}`;
}

const wrapUri = (uri: string, base: string): string => {
  let abs: string;
  try {
    abs = new URL(uri, base).toString();
  } catch {
    return uri;
  }
  return proxiedPath(abs);
};

/** Rewrites every URI line and every `URI="..."` attribute to an absolute, proxied URL. */
export function rewritePlaylist(text: string, base: string): string {
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

function isPlaylist(contentType: string, finalUrl: string): boolean {
  if (/mpegurl/i.test(contentType)) return true;
  try {
    return new URL(finalUrl).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqUrl = new URL(req.url ?? '', 'http://localhost');
  const raw = reqUrl.searchParams.get('u');
  let target: URL;
  try {
    target = new URL(raw ?? '');
  } catch {
    fail(res, 400, 'Missing or invalid u parameter');
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    fail(res, 400, 'Only http and https targets are allowed');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.end();
    return;
  }

  // Abort the upstream request as soon as the browser goes away, so no connection stays open.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  // Playlists are rewritten, so a byte range of the original would not match the body we send:
  // ranges are only forwarded for non-playlist targets.
  const headers: Record<string, string> = {};
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  if (range && !isPlaylist('', target.toString())) headers.range = range;

  const get = (h: Record<string, string>) => fetch(target, { redirect: 'follow', headers: h, signal: controller.signal });
  let upstream: Response;
  try {
    upstream = await get(headers);
    if (headers.range && upstream.status === 206 && isPlaylist(upstream.headers.get('content-type') ?? '', upstream.url)) {
      await upstream.body?.cancel();
      upstream = await get({});
    }
  } catch {
    // The target URL may carry credentials; never echo it.
    fail(res, 502, 'Upstream request failed');
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  res.statusCode = upstream.status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (isPlaylist(contentType, upstream.url)) {
    const body = rewritePlaylist(await upstream.text(), upstream.url);
    // Normalised so native HLS players accept it whatever the upstream announced.
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(body);
    return;
  }
  if (contentType) res.setHeader('Content-Type', contentType);
  for (const h of ['content-length', 'content-range', 'accept-ranges'] as const) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
}

export function devProxy(): Plugin {
  return {
    name: 'iptv-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('The dev proxy must never run with NODE_ENV=production.');
      }
      server.middlewares.use(PROXY_PATH, (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
          fail(res, 405, 'Method not allowed');
          return;
        }
        handle(req, res).catch(() => fail(res, 500, 'Proxy error'));
      });
    },
  };
}
