import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { channels, GROUPS, m3u, slots, TEST_STREAM, xmltv } from './data.ts';

export interface FakeXtreamOptions { port?: number; channels?: number; now?: () => number }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export async function startFakeXtream(opts: FakeXtreamOptions = {}) {
  const chs = channels(opts.channels ?? 200);
  const now = opts.now ?? Date.now;
  let base = '';

  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // CORS: the browser dev UI runs on another origin. Set before any writeHead so it
    // applies to every response (redirects, errors, 404s).
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' });
      return res.end();
    }

    const url = new URL(req.url ?? '/', base);
    const user = url.searchParams.get('username') ?? '';
    const pass = url.searchParams.get('password') ?? '';
    const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.(ts|m3u8)$/.exec(url.pathname);
    const effectiveUser = live ? decodeURIComponent(live[1]!) : user;
    if (effectiveUser === 'slow') await new Promise((r) => setTimeout(r, 3000));
    if (effectiveUser === 'error500') return send(res, 500, '{}');

    if (live) {
      res.writeHead(302, { location: TEST_STREAM });
      return res.end();
    }

    const valid = (user === 'test' || user === 'slow' || user === 'expired') && pass === 'test';

    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action');
      if (!action) {
        if (!valid) return send(res, 200, JSON.stringify({ user_info: { auth: 0 } }));
        return send(res, 200, JSON.stringify({
          user_info: { auth: 1, status: user === 'expired' ? 'Expired' : 'Active', exp_date: String(Math.floor(now() / 1000) + 30 * 86400), max_connections: '1' },
          server_info: { url: base, timezone: 'UTC' },
        }));
      }
      if (!valid) return send(res, 200, '[]');
      if (action === 'get_live_categories') {
        return send(res, 200, JSON.stringify(GROUPS.map((name, i) => ({ category_id: String(i + 1), category_name: name, parent_id: 0 }))));
      }
      if (action === 'get_live_streams') {
        return send(res, 200, JSON.stringify(chs.map((c) => ({
          num: c.n, name: c.name, stream_type: 'live', stream_id: c.n, stream_icon: '', epg_channel_id: c.epgId, category_id: c.categoryId,
        }))));
      }
      if (action === 'get_short_epg') {
        const id = Number(url.searchParams.get('stream_id'));
        const limit = Number(url.searchParams.get('limit') ?? 2);
        const c = chs.find((x) => x.n === id);
        const upcoming = slots(now()).filter((s) => s.stop > now()).slice(0, limit);
        return send(res, 200, JSON.stringify({
          epg_listings: c ? upcoming.map((s) => ({
            title: b64(`Programme ${s.index}`), description: b64(`Synthetic listing for ${c.name}.`),
            start_timestamp: String(s.start / 1000), stop_timestamp: String(s.stop / 1000),
          })) : [],
        }));
      }
      return send(res, 200, '[]');
    }

    if (url.pathname === '/xmltv.php') {
      if (!valid) return send(res, 401, '');
      res.writeHead(200, { 'content-type': 'application/xml' });
      for (const part of xmltv(chs, now())) res.write(part);
      return res.end();
    }

    if (url.pathname === '/get.php') {
      if (!valid) return send(res, 401, '');
      return send(res, 200, m3u(chs, base, user, pass), 'audio/x-mpegurl');
    }

    return send(res, 404, 'not found', 'text/plain');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else send(res, 500, '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 8899, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
