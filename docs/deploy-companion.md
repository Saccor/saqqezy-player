# Deploying the companion web app

The companion (`apps/companion`) is a static site for Cloudflare Pages. `pnpm build:companion` writes it to
`apps/companion/dist/`. Task 8 of Plan 4 completes this guide.

## Security headers (`apps/companion/public/_headers`)

Vite copies `public/_headers` into `dist/`, and Cloudflare Pages applies it to every response:

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss://RELAY_ORIGIN_PLACEHOLDER ws://127.0.0.1:8787; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`

**Before each production deploy, set the relay origin.** Replace `wss://RELAY_ORIGIN_PLACEHOLDER` in
`_headers` with the production relay origin, the same host as `VITE_RELAY_URL` for that build (for example
`wss://relay.example.com`). If you skip this, the browser blocks the WebSocket and pairing fails with
"Can't reach the TV".

Notes:
- `ws://127.0.0.1:8787` is the local dev relay (`pnpm relay:dev`). It is harmless in production, but you can
  remove it from production builds.
- `img-src https:` is needed because channel logos come from the user's own playlist and guide URLs.
- The build has no inline scripts or styles (`script-src 'self'` and `style-src 'self'` hold). Check
  `dist/index.html` after changing the Vite config or adding a plugin.

## Build variables

- `VITE_RELAY_URL`: the relay WebSocket origin (default `ws://127.0.0.1:8787`).
