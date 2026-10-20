// The public read side (spec §1): feed files from the store, cacheable by anyone. Never reads anything from the
// request but its method, path and If-None-Match, and logs nothing.

export interface FeedObject { body: string; etag: string }
export interface FeedReader { get(key: string): Promise<FeedObject | null> }

const ROUTE = /^\/trending\/v1\/(movie|series)\.([a-z]{2,3})\.json$/;
const CORS = { 'access-control-allow-origin': '*' };

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...headers } });
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

export async function serveFeed(request: Request, reader: FeedReader): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed', { allow: 'GET, HEAD, OPTIONS' });
  if (url.pathname === '/healthz') return text(200, 'ok');
  const m = ROUTE.exec(url.pathname);
  if (!m) return text(404, 'not found');
  const obj = await reader.get(`trending/v1/${m[1]}.${m[2]}.json`);
  if (!obj) return text(404, 'not found');
  const headers = {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=21600',
    etag: obj.etag,
  };
  if (etagMatches(request.headers.get('if-none-match'), obj.etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}
