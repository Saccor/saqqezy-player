import { existsSync, readFile } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  channels, episodeId, GROUPS, m3u, MOVIE_GROUPS, movies, posterSvg, SERIES_GROUPS, seriesList, slots, TEST_STREAM, VOD_EXT, xmltv,
} from './data.ts';
import { handleOpenSubtitles } from './openSubtitles.ts';

export interface FakeXtreamOptions {
  port?: number;
  channels?: number;
  /** Only the first N channels get guide data in the XMLTV (default: all). */
  epgChannels?: number;
  /** Synthetic movies (default 120) and series (default 12). */
  movies?: number;
  series?: number;
  /** List every movie and series title three times, as language and quality variants (for combining duplicates). */
  versions?: boolean;
  now?: () => number;
  /**
   * Generated test media (default: `tools/fake-xtream/media`). When `multitrack/master.m3u8` exists there
   * (`scripts/make-multitrack.mjs`), movie 1 plays it: two audio and two subtitle tracks.
   */
  mediaDir?: string;
}

const DEFAULT_MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
const MEDIA_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', vtt: 'text/vtt', mkv: 'video/x-matroska',
};
/** Movie stream id that plays the multi-track title when it was generated. */
const MULTITRACK_MOVIE = 1;
/** Movie stream id that plays the AC-3 sound file (`scripts/make-ac3.mjs`) when it was generated, listed as mkv. */
const AC3_MOVIE = 2;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Synthetic users for the source-retry preview. Each logs in like `test`/`test`, except as named:
 * `refuse403` streams answer 403, `limit429` streams answer 429 with `Retry-After: 90`, `gone404` streams answer 404,
 * and `down500`'s `player_api.php` answers 500.
 */
const STREAM_STATUS: Record<string, { status: number; headers?: Record<string, string> }> = {
  refuse403: { status: 403 },
  limit429: { status: 429, headers: { 'retry-after': '90' } },
  gone404: { status: 404 },
};
const RETRY_USERS = ['refuse403', 'limit429', 'gone404', 'down500'];

export async function startFakeXtream(opts: FakeXtreamOptions = {}) {
  const chs = channels(opts.channels ?? 200);
  const now = opts.now ?? Date.now;
  const mediaDir = opts.mediaDir ?? DEFAULT_MEDIA_DIR;
  const ac3File = () => existsSync(join(mediaDir, 'ac3', 'film.mkv'));
  /** A movie's container: mkv for the AC-3 file when it exists, else the shared HLS extension. */
  const movieExt = (n: number) => (n === AC3_MOVIE && ac3File() ? 'mkv' : VOD_EXT);
  const guided = chs.slice(0, opts.epgChannels ?? chs.length);
  const mvs = movies(opts.movies ?? 120, now(), opts.versions === true);
  const srs = seriesList(opts.series ?? 12, opts.versions === true);
  let base = '';
  /** Refusal mode (`/__control/refuse?on=1`): every source request answers 403, as a refusing panel does. */
  let refusing = false;
  let refusedCount = 0;

  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // CORS: the browser dev UI runs on another origin. Set before any writeHead so it
    // applies to every response (redirects, errors, 404s).
    res.setHeader('access-control-allow-origin', '*');
    // The player's status probe reads Retry-After cross-origin.
    res.setHeader('access-control-expose-headers', 'Retry-After');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': '*' });
      return res.end();
    }

    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/__control/refuse') {
      const on = url.searchParams.get('on');
      if (on !== null) {
        refusing = on === '1';
        refusedCount = 0;
      }
      return send(res, 200, JSON.stringify({ refusing, refused: refusedCount }));
    }
    if (await handleOpenSubtitles(req, res, url, base)) return;
    if (refusing) {
      refusedCount++;
      return send(res, 403, '');
    }
    const user = url.searchParams.get('username') ?? '';
    const pass = url.searchParams.get('password') ?? '';
    const stream = /^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.([a-z0-9]+)$/.exec(url.pathname);
    const effectiveUser = stream ? decodeURIComponent(stream[2]!) : user;
    if (effectiveUser === 'slow') await new Promise((r) => setTimeout(r, 3000));
    if (effectiveUser === 'error500') return send(res, 500, '{}');

    if (stream) {
      const answer = STREAM_STATUS[effectiveUser];
      if (answer) {
        res.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers });
        return res.end();
      }
      const movie = stream[1] === 'movie' ? Number(stream[4]) : undefined;
      const multitrack = movie === MULTITRACK_MOVIE && existsSync(join(mediaDir, 'multitrack', 'master.m3u8'));
      const ac3 = movie === AC3_MOVIE && ac3File();
      const location = multitrack ? `${base}/media/multitrack/master.m3u8` : ac3 ? `${base}/media/ac3/film.mkv` : TEST_STREAM;
      res.writeHead(302, { location });
      return res.end();
    }

    // Generated test media: one folder level, plain file names only (no traversal).
    const media = /^\/media\/([a-z0-9-]+)\/([a-z0-9_-]+)\.(m3u8|ts|vtt|mkv)$/.exec(url.pathname);
    if (media) {
      const file = join(mediaDir, media[1]!, `${media[2]}.${media[3]}`);
      return readFile(file, (err, body) => {
        if (err) return send(res, 404, '');
        res.writeHead(200, { 'content-type': MEDIA_TYPES[media[3]!]! });
        res.end(body);
      });
    }

    const poster = /^\/poster\/([a-z]\d+)\.svg$/.exec(url.pathname);
    if (poster) return send(res, 200, posterSvg(`Synthetic ${poster[1]}`), 'image/svg+xml');

    const valid = (user === 'test' || user === 'slow' || user === 'expired' || user === 'vodall' || RETRY_USERS.includes(user)) && pass === 'test';

    if (url.pathname === '/player_api.php') {
      if (user === 'down500') return send(res, 500, '{}');
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
      const catFilter = user === 'vodall' ? null : url.searchParams.get('category_id');
      if (action === 'get_vod_categories') {
        return send(res, 200, JSON.stringify(MOVIE_GROUPS.map((name, i) => ({ category_id: String(i + 1), category_name: name, parent_id: 0 }))));
      }
      if (action === 'get_vod_streams') {
        return send(res, 200, JSON.stringify(mvs.filter((m) => !catFilter || m.categoryId === catFilter).map((m) => ({
          num: m.n, name: m.name, stream_type: 'movie', stream_id: m.n, stream_icon: `${base}/poster/m${m.n}.svg`,
          rating: m.rating, added: String(m.added), category_id: m.categoryId, container_extension: movieExt(m.n),
        }))));
      }
      if (action === 'get_vod_info') {
        const m = mvs.find((x) => x.n === Number(url.searchParams.get('vod_id')));
        if (!m) return send(res, 200, '[]');
        return send(res, 200, JSON.stringify({
          info: {
            plot: `Synthetic plot for ${m.name}.`, duration_secs: String(5400 + m.n * 60), genre: MOVIE_GROUPS[Number(m.categoryId) - 1],
            director: 'Synthetic Director', cast: 'Synthetic Actor A, Synthetic Actor B', mpaa_rating: '12',
            backdrop_path: [`${base}/poster/b${m.n}.svg`], releasedate: `${m.year}-01-01`, tmdb_id: String(900000 + m.n),
          },
          movie_data: { stream_id: m.n, name: m.name, container_extension: movieExt(m.n) },
        }));
      }
      if (action === 'get_series_categories') {
        return send(res, 200, JSON.stringify(SERIES_GROUPS.map((name, i) => ({ category_id: String(i + 1), category_name: name, parent_id: 0 }))));
      }
      if (action === 'get_series') {
        return send(res, 200, JSON.stringify(srs.filter((s) => !catFilter || s.categoryId === catFilter).map((s) => ({
          num: s.n, name: s.name, series_id: s.n, cover: `${base}/poster/s${s.n}.svg`, rating: '7.5',
          last_modified: String(Math.floor(now() / 1000) - s.n * 7200), category_id: s.categoryId, releaseDate: '2021-01-01',
        }))));
      }
      if (action === 'get_series_info') {
        const s = srs.find((x) => x.n === Number(url.searchParams.get('series_id')));
        if (!s) return send(res, 200, '[]');
        const episodes: Record<string, unknown[]> = {};
        for (let season = 1; season <= s.seasons; season++) {
          episodes[String(season)] = Array.from({ length: s.perSeason }, (_, i) => ({
            id: String(episodeId(s.n, season, i + 1)), episode_num: i + 1, season,
            title: `${s.name} - S${String(season).padStart(2, '0')}E${String(i + 1).padStart(2, '0')} - Episode ${i + 1}`,
            container_extension: VOD_EXT,
            info: { duration_secs: 2700 + i * 60, plot: `Synthetic episode ${i + 1}.`, movie_image: `${base}/poster/e${episodeId(s.n, season, i + 1)}.svg` },
          }));
        }
        return send(res, 200, JSON.stringify({
          seasons: Array.from({ length: s.seasons }, (_, i) => ({ season_number: i + 1, name: `Season ${i + 1}` })),
          info: {
            name: s.name, plot: `Synthetic plot for ${s.name}.`, genre: SERIES_GROUPS[Number(s.categoryId) - 1], backdrop_path: [`${base}/poster/b${s.n}.svg`],
            tmdb: String(800000 + s.n),
          },
          episodes,
        }));
      }
      return send(res, 200, '[]');
    }

    if (url.pathname === '/xmltv.php') {
      if (!valid) return send(res, 401, '');
      res.writeHead(200, { 'content-type': 'application/xml' });
      for (const part of xmltv(guided, now())) res.write(part);
      return res.end();
    }

    if (url.pathname === '/get.php') {
      if (!valid) return send(res, 401, '');
      return send(res, 200, m3u(chs, base, user, pass, { movies: mvs }), 'audio/x-mpegurl');
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
