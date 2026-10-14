# Deploying the companion web app

The companion (`apps/companion`) is a static site for Cloudflare Pages. `pnpm build:companion` writes it to
`apps/companion/dist/`. Task 8 of Plan 4 completes this guide.

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

- `VITE_RELAY_URL`: the relay WebSocket origin (default `ws://127.0.0.1:8787`).
