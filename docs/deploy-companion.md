# Deploying the companion (relay + web app)

"Manage on phone or computer" has two parts that run on Cloudflare:

- **The relay** (`services/relay`): a small Cloudflare Worker. It passes encrypted messages between the TV and
  the phone. It cannot read them and it stores nothing.
- **The companion web app** (`apps/companion`): the page you open on your phone or computer. It is a static site
  on Cloudflare Pages.

Your TV app then needs to know both addresses, so you build it again at the end.

## This project's deployment (short version)

Both parts are already live, and both deploy from the repo root with one command each (after
`pnpm install` and, once per computer, `pnpm dlx wrangler login`):

| Part | Command | Config | Address |
|---|---|---|---|
| Relay | `pnpm relay:deploy` | `services/relay/wrangler.toml` | `wss://iptv-relay-production.sacco-rezais.workers.dev` |
| Companion page | `pnpm companion:deploy` | `apps/companion/wrangler.jsonc` | `https://saqqezy-companion.sacco-rezais.workers.dev` |

- `pnpm companion:deploy` (`scripts/companion-deploy.mjs`) builds the page with
  `VITE_RELAY_URL=wss://iptv-relay-production.sacco-rezais.workers.dev` and `REQUIRE_PROD_ENV=1`, then runs
  `wrangler deploy` in `apps/companion` (wrangler refuses to run at the pnpm workspace root). It works the same in
  PowerShell and Git Bash. Add `--dry-run` to build and check without uploading.
- The page is a **static-assets Worker** (`saqqezy-companion`), not a Pages project: no Worker script, only
  `dist/`. Workers static assets applies the generated `dist/_headers` (CSP with the relay origin), as Pages does.
  Observability and wrangler metrics are off.
- The relay's `ALLOWED_ORIGINS` already lists the companion page and the local TV dev origins
  (`services/relay/README.md`, "Production").
- TV dev builds read `VITE_COMPANION_ORIGIN` and `VITE_RELAY_URL` from the git-ignored `apps/tv/.env.local`.
  Set them to the two addresses above.
- Deploy the relay first when both change, so the relay already accepts the page's origin.

The rest of this guide is the full walkthrough for a fresh account or your own domain.

This guide takes about an hour the first time. You type a few commands in a terminal (PowerShell on Windows) and
click through the Cloudflare dashboard. You do not need to program. Until you deploy, everything also runs on your
own computer: see "Manage from your phone (local test)" in [try-v1.md](try-v1.md).

The examples use these names. Replace them with your own everywhere:

| Example | What it is |
|---|---|
| `example.com` | Your domain |
| `relay.example.com` | The relay's address |
| `manage.example.com` | The companion web app's address |

## 1. Create a Cloudflare account

1. Go to dash.cloudflare.com and sign up. The free plan is enough.
2. Confirm your e-mail address.

## 2. Choose your addresses

You have two options.

- **With your own domain (recommended).** In the dashboard, choose **Add a domain**, type your domain and follow the
  steps. Cloudflare shows two "nameservers"; enter them at the company where you bought the domain. It can take a
  few hours before the dashboard shows the domain as **Active**. Wait for that before step 5.
- **Without a domain (for testing).** Cloudflare gives you free addresses:
  - the relay: `iptv-relay-production.<your-account>.workers.dev`
  - the web app: `<project-name>.pages.dev`

  You see the exact names after the first deploy (steps 5 and 6). Use them instead of `relay.example.com` and
  `manage.example.com` in the rest of this guide.

## 3. Log in from your computer

In a terminal, in the project folder (the folder with `package.json`):

```
pnpm install
pnpm dlx wrangler login
```

A browser window opens. Log in to Cloudflare and click **Allow**. `wrangler` is Cloudflare's command-line tool;
you only log in once per computer.

## 4. Tell the relay which web app may connect (`ALLOWED_ORIGINS`)

Open `services/relay/wrangler.toml` in a text editor. Near the bottom, find the `ALLOWED_ORIGINS` line under
`[env.production.vars]`. Its first entry is this project's companion page; the `http://localhost:...` entries are
for TV dev builds on this computer. Replace the first entry with your web app's address:

- `https://` plus the host name, nothing else: no path and no `/` at the end.
- For the test addresses it looks like `https://iptv-companion.pages.dev`.
- **Hosted TV builds** served from a website (for example a future Titan OS build) are added to the same line,
  separated by commas: `"https://manage.example.com,https://tv.example.com"`.
- The Samsung (`.wgt`) and LG packages need no entry.

Save the file. Leave the `[vars]` section at the top alone: it is only for running on your computer.

## 5. Deploy the relay

```
pnpm relay:deploy
```

This uploads the relay with the production settings. At the end it prints the relay's address, for example
`https://iptv-relay-production.<your-account>.workers.dev`.

**Use your own domain for the relay (optional, recommended):**

1. In the dashboard, open **Workers & Pages** and click **iptv-relay-production**.
2. Open **Settings → Domains & Routes → Add → Custom domain**.
3. Type `relay.example.com` and confirm. Cloudflare creates the DNS record and the certificate for you.

From now on, the relay's WebSocket address is `wss://relay.example.com` (or
`wss://iptv-relay-production.<your-account>.workers.dev`). Note that it starts with **`wss://`**, not `https://`.

If the deploy stops with an error that mentions a Durable Object "migration", do not change anything; note the
message and ask for help. (This is the first real deploy of the relay's storage-free session class.)

## 6. Create the web app (Cloudflare Pages)

The web app must be built with the relay's address inside it. Pick **one** of the two ways.

### Way A: upload from your computer (simplest)

In PowerShell, in the project folder:

```
$env:VITE_RELAY_URL = "wss://relay.example.com"
pnpm build:companion
pnpm dlx wrangler pages deploy apps/companion/dist --project-name iptv-companion
```

- The first time, `wrangler` asks to create the project. Answer yes, and choose `main` as the production branch.
- It prints the address, for example `https://iptv-companion.pages.dev`.
- Run these three lines again whenever the companion changes. Close the terminal afterwards (or run
  `Remove-Item Env:VITE_RELAY_URL`) so the setting does not stick to other builds.

### Way B: let Cloudflare build it from your Git repository

Only if the project is on GitHub or GitLab. In the dashboard: **Workers & Pages → Create → Pages → Connect to Git**,
choose the repository, then set:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `pnpm build:companion` |
| Build output directory | `apps/companion/dist` |
| Root directory | (leave empty) |
| Environment variable `VITE_RELAY_URL` | `wss://relay.example.com` |
| Environment variable `NODE_VERSION` | `22` |

Every push to the production branch then builds and publishes the web app.

### Your own domain for the web app (optional, recommended)

In **Workers & Pages → iptv-companion → Custom domains → Set up a custom domain**, type `manage.example.com` and
confirm.

If the web app's final address is different from what you put in `ALLOWED_ORIGINS` in step 4, fix
`wrangler.toml` and run `pnpm relay:deploy` again. Otherwise the relay refuses the phone.

The build also writes the page's security headers (`dist/_headers`); see "Security headers" below. There is nothing
to set by hand.

## 7. Build the TV app with your addresses

The TV app has to know where the relay is, and which address to show in the QR code. In PowerShell, in the
project folder:

```
$env:VITE_RELAY_URL = "wss://relay.example.com"
$env:VITE_COMPANION_ORIGIN = "https://manage.example.com"
pnpm build:tizen
```

- `VITE_COMPANION_ORIGIN` is the web app's address, starting with `https://`, without a `/` at the end.
- `pnpm build:tizen` builds the TV app and makes the Samsung package. Install it as described in
  [install-on-samsung.md](install-on-samsung.md). For a browser build only, use `pnpm build:tv`.
- Without these two settings the TV uses the local test addresses (`ws://127.0.0.1:8787` and
  `http://localhost:5174`), which only work on your own computer.

## 8. Check that it works

1. Open `https://relay.example.com/healthz` in a browser. It must show only the word **`ok`**.
2. Open `https://manage.example.com` on your phone. It shows **Manage your TV** with a code field.
3. On the TV, open **Settings → Manage on phone or computer** and scan the QR code with the phone's camera.
   Within a few seconds the phone shows your sources and the TV shows **Connected**.
4. Try the code too: on the TV press **Yellow** (use a code instead) and type the code on the phone.

If the phone says it cannot reach the TV:

- Check that `ALLOWED_ORIGINS` (step 4) is exactly the address in the phone's address bar, starting with `https://`.
- Check that `VITE_RELAY_URL` starts with `wss://` and was set when you built the web app (step 6) and the TV
  app (step 7).
- Codes expire. On the TV choose **Show a new code** and try again.

## 9. Privacy: what Cloudflare and the relay can see

Everything between the TV and the phone is encrypted on the TV and on the phone with a key that only those two
have (it is in the QR code or comes from the code). The relay passes the encrypted messages along and forgets
them.

**What the relay can see:**

- a random session id (it is part of the address the TV and the phone connect to),
- the size of each encrypted message, and when it was sent,
- that a TV and a phone are connected to the same session, and when they connect and disconnect.

Like any web server, Cloudflare's network also sees the IP addresses of the devices that connect.

**What it cannot see:** anything else. Not your sources, server addresses, usernames or passwords, channel names,
lists or settings. Those exist only on your TV (and, while an edit form is open, in the phone's memory).

**What it keeps:** nothing. The relay stores no messages, no session ids and no IP addresses. Its new-session
limit counts per IP address only in memory, as a scrambled value (a keyed hash) that is never written anywhere.
Sessions end after at most 60 minutes, and all of their state is in memory only.

**Keep logging off.** The relay does not log anything itself, but Cloudflare offers logging features that could
record the session id and IP address of each connection. Check these once after the first deploy:

1. **Workers & Pages → iptv-relay-production → Settings → Observability:** "Workers Logs" must be **disabled**
   (the project turns it off in `wrangler.toml`; this confirms it). There should be no **Logpush** destination.
2. **Your domain → Analytics & Logs → Logpush** (only shown on plans that have it): no job may include the relay's
   host name (`relay.example.com`).
3. Do not run `wrangler tail` against the production relay. It shows live requests, including session ids.

The normal Cloudflare dashboard statistics (request counts, error rates) do not show session ids.

**Still open:** a GDPR review of the relay (Cloudflare as processor, the data processing agreement, and the
privacy policy text for the store listings) has not been done yet. Do it before the app is offered to other
people.

## Security headers (`dist/_headers`, generated)

`pnpm build:companion` writes `dist/_headers` (a Vite plugin in `apps/companion/vite.config.ts`, using
`apps/companion/src/build/headers.ts`), and Cloudflare Pages applies it to every response:

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' <relay origin>; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`

`<relay origin>` is the scheme, host and port of `VITE_RELAY_URL` for that build (for example
`wss://relay.example.com`). Without `VITE_RELAY_URL` it is the local dev relay, `ws://127.0.0.1:8787`. There is
no manual step: set `VITE_RELAY_URL` for the production build and the CSP follows. The build fails if
`VITE_RELAY_URL` is not a `ws:` or `wss:` URL.

Notes:
- Don't edit `dist/_headers` by hand; it is rewritten on every build.
- `img-src https:` is needed because channel logos come from the user's own playlist and guide URLs.
- The build has no inline scripts or styles (`script-src 'self'` and `style-src 'self'` hold). Check
  `dist/index.html` after changing the Vite config or adding a plugin.

## Build variables

| Variable | Used by | Default (local test) | Production |
|---|---|---|---|
| `VITE_RELAY_URL` | TV app and web app | `ws://127.0.0.1:8787` | `wss://relay.example.com` |
| `VITE_COMPANION_ORIGIN` | TV app (the QR code and the address shown with the code) | `http://localhost:5174` | `https://manage.example.com` |

Relay settings live in `services/relay/wrangler.toml`; see `services/relay/README.md` for its limits, close codes
and development scripts.
