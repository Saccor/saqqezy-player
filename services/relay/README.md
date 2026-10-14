# @iptv/relay

The companion relay: a Cloudflare Worker with one Durable Object per pairing session. It forwards
opaque, end-to-end encrypted frames between one TV socket and one phone socket. It cannot read them,
and it stores nothing: no Durable Object storage, no logs of frame contents, session ids or IPs.

## Endpoints

- `GET /v1/session/<sessionId>/ws?role=tv|phone`: WebSocket upgrade. `sessionId` is 16 bytes as
  canonical base64url (22 characters). Binary frames only.
- `GET /healthz`: returns `ok`.

## Limits

| Limit | Value |
|---|---|
| Sockets per session | one `tv`, one `phone`; a new socket replaces the old one |
| Frame size | 300 KiB |
| Frame rate | 200 frames per 10 s per socket |
| New sessions | 10 per minute per IP (in memory only; joins and reconnects to a known session do not count) |
| Session lifetime | 15 minutes from creation, 5 minutes idle |
| Reconnect queue | 2 MiB and 60 s per waiting peer |

Origins listed in `ALLOWED_ORIGINS` (`wrangler.toml`) may connect with either role. A missing Origin,
`Origin: null` or `file://` is allowed only for `role=tv` (packaged TV apps).

## Close codes

| Code | Meaning |
|---|---|
| 4000 | session expired (reason `expired` or `idle`) |
| 4001 | replaced by a newer socket of the same role |
| 4002 | frame too large |
| 4003 | rate limit |
| 4004 | bad role |
| 1003 | a text frame was sent (binary only) |

## Code layout

- `src/sessionCore.ts`: pure session logic (forwarding, queue, limits, timers), unit-tested with a
  fake clock in `test/sessionCore.test.ts` (part of `pnpm test`).
- `src/limits.ts`: limits, close codes, session id, origin and per-IP helpers.
- `src/worker.ts`: routing, Origin rules, the per-IP limit and the `Session` Durable Object.

## Development

```sh
pnpm relay:dev        # wrangler dev, fully local (Miniflare) on 127.0.0.1:8787; no account needed
pnpm relay:test:int   # integration checks against the running relay
```

`pnpm relay:test:int` runs `scripts/integration.mjs`. It expects `pnpm relay:dev` to be running
(it waits up to 30 s for `/healthz`), uses random synthetic session ids and frames, checks
forwarding both ways, the reconnect queue, replacement (4001), oversized frames (4002), bad role
(4004), Origin refusal and the session id format, and exits non-zero on any failure. Set
`RELAY_URL` to point it elsewhere. It is not part of `pnpm test`.

Each run opens 4 new sessions, so more than two runs within a minute from the same machine hit the
per-IP new-session limit (HTTP 429) until the window passes or the dev server reloads.

`pnpm relay:deploy` runs `wrangler deploy` and needs a Cloudflare account.
