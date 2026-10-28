# @iptv/trending

The public trending feed behind Start's "Trending movies" and "Trending series" rows. A Cloudflare Worker with a Cron
Trigger every 6 h builds, per language, a small JSON of trending film and series ids, titles and years from
**Wikimedia pageviews** and **Wikidata** (both CC0), optionally boosted by **TMDB** during the beta, and serves it
from R2.

The TV matches the feed against the user's own library on the device and shows only titles the user already has.
Devices send a bare `GET /trending/v1/movie.sv.json`: no ids, no library data, no account. The Worker never sees
user data, streams, playlists or guides ([docs/GUARDRAILS.md](../../docs/GUARDRAILS.md) rules 6 and 7), and it logs one summary line per run.

## Endpoints

- `GET /trending/v1/{movie|series}.{lang}.json`: feed v1 (`{ v: 1, kind, lang, at, items: [{ rank, wd, tmdb?, imdb?,
  year?, titles }] }`, at most 150 items). `Cache-Control: public, max-age=21600`, `ETag` (304 on `If-None-Match`),
  `Access-Control-Allow-Origin: *`. A language that was never built is 404 (the TV then asks for `en`).
- `GET /healthz`: `ok`.

## How a run works

Per language, one request at a time with a 500 ms pause, at most 45 external requests per run (the free plan allows
50 subrequests):

1. Wikimedia top articles for each of the last 7 complete days (`cache/pageviews/<lang>/<day>.json` in R2: a day is
   fetched once).
2. The top 500 articles by summed views (no namespaces, no main page) → Wikidata `wbgetentities` in batches of 50 for
   articles not seen in the last 7 days (`cache/entities/<lang>.json` keeps a compact summary per article).
3. Films and series by "instance of" (P31, including common subclasses) with TMDB ids (P4947/P4983), IMDb id (P345),
   release year (P577, else P580) and titles (label in the language, English label, aliases).
4. Score = summed views × recency; with `TMDB_KEY`, titles in TMDB's weekly trending get a rank boost by tmdb id.
5. `trending/v1/{movie,series}.<lang>.json` written to R2.

When the budget runs out, or Wikimedia answers 429/503, the run stops and the next one continues with the language it
stopped at (`cache/state.json`). Once the caches are warm a language costs 1 to 3 requests.

## Setup (once)

```sh
cd services/trending
npx wrangler login
npx wrangler r2 bucket create iptv-trending          # production bucket ([env.production] in wrangler.toml)
npx wrangler r2 bucket create iptv-trending-dev      # only if you run `wrangler dev` against remote storage
```

Configuration:

| Name | Kind | Required | What |
|---|---|---|---|
| `CONTACT` | var | yes | Contact for Wikimedia's User-Agent policy: a URL or an address of the operator. Goes into `User-Agent: SaqqezyTrending/1 (<CONTACT>)`. **Never commit it**: pass it at deploy time. A cron run without it fails with "CONTACT is not set". |
| `LANGS` | var | no | Comma-separated Wikipedia codes; default `en,sv,de,fr,es,it,nl,pl,tr,ar,fa,da,no,fi,pt` |
| `TMDB_KEY` | secret | no | **Beta only.** The free TMDB developer key (v3 key or v4 read token). Remove it the day licences go on sale: `npx wrangler secret delete TMDB_KEY --env production`. Without it everything still works. |

```sh
npx wrangler secret put TMDB_KEY --env production     # beta only
pnpm trending:deploy --var CONTACT:https://your-site.example/contact
```

(`pnpm trending:deploy` runs `wrangler deploy --env production`; extra arguments go to wrangler.)

Then build the TV app with `VITE_TRENDING_URL=https://<worker host>/trending` (see `docs/deploy-trending.md`). While
the TMDB key is set, build it with `VITE_TMDB_ATTRIBUTION=1` too.

## About-screen attribution

- Always: "Popularity: Wikimedia pageview statistics. Identifiers and titles: Wikidata. Both CC0." (courtesy; no
  Wikipedia logo).
- While `TMDB_KEY` is set: the TMDB logo and "This product uses the TMDB API but is not endorsed or certified by TMDB."
  The TV shows the text when built with `VITE_TMDB_ATTRIBUTION=1`.

## CPU time (read before relying on the free plan)

Wikidata answers carry every claim of an entity: a batch of 50 popular articles is about 3 MB of JSON and about 16 ms
of parsing on a laptop. The free plan allows 10 ms of CPU per invocation, so a cold run (or a day with many new
articles) can be cut off there. The caches keep warm runs small, but **Workers Paid (USD 5/month) is the safe
choice**. If it must stay free, replace step 2's type lookup with one Wikidata SPARQL query per batch (small answers);
`summarizeEntity` is the only code that would change.

## Development

```sh
pnpm trending:dev        # wrangler dev, local R2 and the cron at http://127.0.0.1:8788
curl "http://127.0.0.1:8788/__scheduled?cron=0+*/6+*+*+*"   # run the cron once (start it with `pnpm trending:dev --var CONTACT:<url>`)
```

`wrangler dev` makes real requests to Wikimedia and Wikidata when the cron runs, so set `CONTACT` and keep `LANGS`
short (the dev default is `en,sv`). For the TV on localhost you do not need this Worker: the fake provider serves a
synthetic feed (`tools/fake-xtream`, `/__trending/v1/...`).

Tests (`pnpm test`) never touch the network: the pure parts (`src/wikidata.ts`, `src/rank.ts`), the pipeline with a
fake fetch and an in-memory store, and the fetch handler run against synthetic fixtures.

## Code layout

- `src/feed.ts`: feed v1 types and keys.
- `src/wikidata.ts`: pageviews and Wikidata parsing, the P31 type table, candidate filtering, TMDB ids.
- `src/rank.ts`: `rankFeed` (views × recency, TMDB boost, dedupe, 150 cap).
- `src/pipeline.ts`: one run (`runTrending`): caches, budget, pacing, publish.
- `src/serve.ts`: the read side (paths, ETag, headers).
- `src/worker.ts`: the Worker entry (`fetch`, `scheduled`, R2 adapters).
