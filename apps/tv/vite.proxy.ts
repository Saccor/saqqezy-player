// Developer convenience for desktop browsers only; never shipped; TVs fetch directly.
//
// Two routes, both `GET`/`HEAD`, both fetch `u` server-side inside `vite dev` and stream it back so a desktop
// browser can reach providers that send no CORS headers:
//   `/__proxy/raw?u=<encoded url>`             never rewrites anything (playlist, EPG and API fetches of the worker).
//   `/__proxy/hls/<file name>?u=<encoded url>` rewrites HLS playlists so segment / key / variant URIs come back
//                                              through this route (player URLs only; the file name is kept for native HLS).
//
// Security: the proxy sends NO CORS headers (it is same-origin only, so other sites cannot read it through the
// browser). Requests whose `Sec-Fetch-Site` is neither `same-origin` nor `none`, or whose `Origin` is not the dev
// server's own origin, get 403. It refuses to start when the dev server is exposed beyond loopback.
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { upstreamHeaders } from './src/dev/proxyHeaders.ts';
import { readHeaderParams } from './src/net/headerParams.ts';
import { maskUrl } from './src/dev/maskUrl.ts';
import { rewriteHls } from './src/dev/rewriteHls.ts';
import { UNREACHABLE_HEADER } from './src/net/devProxy.ts';

const PROXY_PATH = '/__proxy';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

/** True when the request can only have come from a page, worker or media element of this dev server. */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (host !== req.headers.host) return false;
  }
  return true;
}

/** Dev-only diagnostics: stream playlists and every refused request, credentials masked. */
function logUpstream(route: string, target: URL, upstream: Response): void {
  const playlist = /\.m3u8?$/i.test(target.pathname) || /mpegurl/i.test(upstream.headers.get('content-type') ?? '');
  const live = route === 'hls' || /\/(live|movie|series)\//.test(target.pathname);
  if (upstream.status < 400 && !(live && playlist) && !(route === 'hls' && !playlist && upstream.status !== 200 && upstream.status !== 206)) return;
  let final = '';
  try {
    const f = new URL(upstream.url);
    if (f.toString() !== target.toString()) final = ` -> ${maskUrl(f)}`;
  } catch { /* no final URL */ }
  console.log(`[proxy] ${upstream.status} ${route} ${maskUrl(target)}${final}`);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The middleware is mounted at PROXY_PATH, so `req.url` is `/raw?u=...` or `/hls/<name>?u=...`.
  const reqUrl = new URL(req.url ?? '', 'http://localhost');
  const route = reqUrl.pathname === '/raw'
    ? 'raw'
    : reqUrl.pathname === '/hls' || reqUrl.pathname.startsWith('/hls/') ? 'hls' : undefined;
  if (!route) {
    fail(res, 404, 'Unknown proxy route');
    return;
  }
  let target: URL;
  try {
    target = new URL(reqUrl.searchParams.get('u') ?? '');
  } catch {
    fail(res, 400, 'Missing or invalid u parameter');
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    fail(res, 400, 'Only http and https targets are allowed');
    return;
  }
  // The source's User-Agent and Referer (`ua`, `ref`): secrets like `u`, never logged or echoed.
  const source = readHeaderParams(reqUrl.searchParams);
  if (source === 'invalid') {
    fail(res, 400, 'Invalid header parameter');
    return;
  }

  // Abort the upstream request as soon as the browser goes away, so no connection stays open.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  // On the hls route a playlist is rewritten, so a byte range of the original would not match the body we send:
  // ranges are only forwarded for non-playlist targets. The raw route never rewrites, so it forwards ranges.
  // Upstream sees our player's own user-agent (or the source's), never the browser's (see `proxyHeaders.ts`).
  // Redirects are followed with the same headers on each hop.
  const headers = upstreamHeaders(req.headers, !(route === 'hls' && isPlaylist('', target.toString())), source);

  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const get = (h: Record<string, string>) => fetch(target, { method, redirect: 'follow', headers: h, signal: controller.signal });
  let upstream: Response;
  try {
    upstream = await get(headers);
    if (route === 'hls' && headers.range && upstream.status === 206 && isPlaylist(upstream.headers.get('content-type') ?? '', upstream.url)) {
      await upstream.body?.cancel();
      upstream = await get(upstreamHeaders(req.headers, false, source));
    }
  } catch {
    // The target URL may carry credentials; never echo it. The marker header lets the dev worker turn this
    // back into the network failure a direct fetch would have given (see `devProxy.ts`).
    if (!res.headersSent) res.setHeader(UNREACHABLE_HEADER, '1');
    fail(res, 502, 'Upstream request failed');
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  logUpstream(route, target, upstream);
  res.statusCode = upstream.status;
  res.setHeader('Cache-Control', 'no-store');

  if (route === 'hls' && isPlaylist(contentType, upstream.url)) {
    const text = await upstream.text();
    const ok = upstream.status >= 200 && upstream.status < 300;
    if (ok && text.includes('#EXT-X-')) {
      // Normalised so native HLS players accept it whatever the upstream announced.
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(rewriteHls(text, upstream.url, source));
    } else {
      if (contentType) res.setHeader('Content-Type', contentType);
      res.end(text);
    }
    return;
  }

  if (contentType) res.setHeader('Content-Type', contentType);
  // Node's fetch has already decoded a compressed body, so the upstream length / range / encoding no longer apply.
  if (!upstream.headers.has('content-encoding')) {
    for (const h of ['content-length', 'content-range', 'accept-ranges'] as const) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
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
      const host = server.config.server.host;
      if (host !== undefined && !(typeof host === 'string' && LOOPBACK_HOSTS.has(host))) {
        throw new Error('The dev proxy refuses to run when the dev server is exposed to the LAN (server.host must be unset or loopback).');
      }
      server.middlewares.use(PROXY_PATH, (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          fail(res, 405, 'Method not allowed');
          return;
        }
        if (!isSameOrigin(req)) {
          fail(res, 403, 'Cross-site requests to the dev proxy are not allowed');
          return;
        }
        handle(req, res).catch(() => fail(res, 500, 'Proxy error'));
      });
    },
  };
}
