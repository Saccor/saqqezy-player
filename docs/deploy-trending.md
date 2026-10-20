# Deploying the trending feed

The Start page's **Trending movies** and **Trending series** rows need a small public feed: a list of trending film
and series ids, titles and years per language. A Cloudflare Worker (`services/trending`) builds it every 6 hours from
Wikimedia pageview statistics and Wikidata (both free and CC0), and during the beta it can also use TMDB with the free
developer key. The TV downloads the feed and shows only the titles the user already has in their own library.

The Worker never sees anything about the user: the TV asks for a public file such as `/trending/v1/movie.sv.json` and
sends nothing else. Background and design: `docs/research/trending-2026-10-20.md`,
`docs/superpowers/specs/2026-10-20-trending-design.md`.

This takes about 20 minutes, in the same Cloudflare account as the relay ([deploy-companion.md](deploy-companion.md),
steps 1 to 3: account, addresses, `pnpm dlx wrangler login`). Nothing here is needed to try the rows on your own
computer: `pnpm dev` serves a synthetic feed from the fake provider.

The examples use `trending.example.com` for the Worker's address. Replace it with your own.

## 1. Choose the plan

The Worker reads Wikidata answers that are a few megabytes each. The free plan allows 10 ms of CPU time per run,
which a run with many new titles can exceed. **Workers Paid (USD 5 per month) is the safe choice.** You can start on
the free plan and switch if the Worker's log shows runs being cut off (see step 7). The R2 storage it uses (a few
megabytes) is within the free R2 allowance either way.

## 2. Create the storage bucket

In the project folder:

```
cd services/trending
pnpm dlx wrangler r2 bucket create iptv-trending
cd ../..
```

The first time, the dashboard may ask you to enable R2 for the account (**R2 Object Storage → Purchase R2 Plan**; the
free allowance costs nothing).

## 3. Choose your contact (`CONTACT`)

Wikimedia asks every program that reads its data to say who runs it, with a way to get in touch, so they can contact
you instead of blocking you. Use a web page or an e-mail address you read, for example
`https://example.com/contact`. It is sent only to Wikimedia and Wikidata, inside the request's User-Agent.

**Never write it into a file in the project.** You pass it on the command line in step 5. Without it, every run stops
with the message "CONTACT is not set".

## 4. Beta only: the TMDB key (`TMDB_KEY`)

Optional. With it, titles that are trending on TMDB this week rank a little higher. Without it everything works.

1. Create a free account at themoviedb.org, then **Settings → API** and request a developer key.
2. Store it in Cloudflare (it is never written to a file):

   ```
   cd services/trending
   pnpm dlx wrangler secret put TMDB_KEY --env production
   cd ../..
   ```

   Paste the **API Read Access Token** (or the shorter API key) when asked.

**The free TMDB key is for the beta only.** The day licences go on sale, remove it:

```
cd services/trending
pnpm dlx wrangler secret delete TMDB_KEY --env production
```

and build the TV app without `VITE_TMDB_ATTRIBUTION` (step 6). A paid TMDB agreement is a separate decision
(research note §6).

## 5. Deploy the Worker

```
pnpm trending:deploy --var CONTACT:https://example.com/contact
```

At the end it prints the Worker's address, for example `https://iptv-trending-production.<your-account>.workers.dev`.

**Your own domain (optional, recommended):** in the dashboard open **Workers & Pages → iptv-trending-production →
Settings → Domains & Routes → Add → Custom domain**, type `trending.example.com` and confirm.

The first run happens at the next full 6 hours (00:00, 06:00, 12:00 or 18:00 UTC). The first runs fill the caches
and build a couple of languages each; after a day every language is ready.

Languages: by default `en, sv, de, fr, es, it, nl, pl, tr, ar, fa, da, no, fi, pt` (`LANGS` in
`services/trending/wrangler.toml`, under `[env.production.vars]`). A TV whose language has no feed uses English.

## 6. Build the TV app with the feed address

In PowerShell, in the project folder, together with the relay settings from
[deploy-companion.md](deploy-companion.md) step 7:

```
$env:VITE_TRENDING_URL = "https://trending.example.com/trending"
$env:VITE_TMDB_ATTRIBUTION = "1"     # only while TMDB_KEY is set (beta)
pnpm build:tizen
```

- The address ends in **`/trending`**, without a `/` at the end.
- Without `VITE_TRENDING_URL` the TV has no trending rows and never asks for a feed.
- `VITE_TMDB_ATTRIBUTION=1` shows "This product uses the TMDB API but is not endorsed or certified by TMDB." in
  **Settings → About**, which TMDB requires while its key is used. Leave it out once the key is removed.

## 7. Check that it works

1. Open `https://trending.example.com/healthz`. It shows only **`ok`**.
2. After the first run, open `https://trending.example.com/trending/v1/movie.en.json`. It shows a list that starts
   with `{"v":1,"kind":"movie","lang":"en",`.
3. On the TV, open **Movies** once (so the library is loaded), then **Start**: **Trending movies** appears when at
   least 4 trending titles are in your library. It may take one visit to Start to download the feed.
4. **Settings → About** lists the data sources.

If a feed stays empty, open **Workers & Pages → iptv-trending-production → Logs** (or run
`pnpm dlx wrangler tail --env production` while a run happens; stop it afterwards). Each run writes one line such as
`trending run: sv:150/150 en:148/150`, or why it stopped (`request budget used up` is normal on the first runs).

## About-screen text

- Always: "Popularity: Wikimedia pageview statistics. Identifiers and titles: Wikidata. Both CC0." (a courtesy; no
  Wikipedia logo).
- While the TMDB key is used: "This product uses the TMDB API but is not endorsed or certified by TMDB." The TMDB logo
  is to be added to About before a public beta (it is not in the app yet).

Store screenshots of the Start page must use synthetic or public-domain titles only (CLAUDE.md rules 3 and 4).
