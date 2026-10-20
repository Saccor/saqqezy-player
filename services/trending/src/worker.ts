// Cloudflare Worker: builds the public trending feed every 6 h (Cron Trigger) and serves it from R2.
//
// Privacy (CLAUDE.md rules 6 and 7): devices send a bare GET for a public file; the Worker reads nothing from them
// and stores nothing about them. It never proxies streams, playlists or guides. The only log line is a run summary.
import { runTrending, type Store } from './pipeline.ts';
import { serveFeed, type FeedReader } from './serve.ts';

export interface Env {
  FEEDS: R2Bucket;
  /** Operator contact for Wikimedia's User-Agent policy. Set at deploy time; never committed. */
  CONTACT?: string;
  /** Comma-separated Wikipedia language codes. */
  LANGS?: string;
  /** Beta only: TMDB v3 key or v4 read token (`wrangler secret put TMDB_KEY`). Remove it the day licences go on sale. */
  TMDB_KEY?: string;
}

export const DEFAULT_LANGS = 'en,sv,de,fr,es,it,nl,pl,tr,ar,fa,da,no,fi,pt';

function readerOf(bucket: R2Bucket): FeedReader {
  return {
    async get(key: string) {
      const obj = await bucket.get(key);
      return obj ? { body: await obj.text(), etag: obj.httpEtag } : null;
    },
  };
}

function storeOf(bucket: R2Bucket): Store {
  return {
    async get(key: string) {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async put(key: string, body: string) {
      await bucket.put(key, body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    },
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return serveFeed(request, readerOf(env.FEEDS));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const run = runTrending({
      fetch: (input, init) => fetch(input, init),
      store: storeOf(env.FEEDS),
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      contact: env.CONTACT ?? '',
      langs: (env.LANGS || DEFAULT_LANGS).split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
      ...(env.TMDB_KEY ? { tmdbKey: env.TMDB_KEY } : {}),
    }).then((s) => {
      const done = s.done.map((d) => `${d.lang}:${d.movie}/${d.series}`).join(' ');
      console.log(`trending run: ${done || 'nothing built'}${s.stopped ? `; stopped: ${s.stopped}` : ''}`);
    });
    ctx.waitUntil(run);
    await run;
  },
};
