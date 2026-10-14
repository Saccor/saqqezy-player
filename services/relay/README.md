# @iptv/relay

The companion relay: a Cloudflare Worker with one Durable Object per pairing session. It forwards
opaque, end-to-end encrypted frames between one TV socket and one phone socket. It cannot read them,
and it stores nothing: no Durable Object storage, no logs of frame contents, session ids or IPs.
Raw IPs are not even held in memory: the per-IP limiter keys on an HMAC of the address prefix.

## Endpoints

- `GET /v1/session/<sessionId>/ws?role=tv|phone`: WebSocket upgrade. `sessionId` is 16 bytes as
  canonical base64url (22 characters). Binary frames only. A 0-byte binary frame is a heartbeat
  (ping): it is not forwarded, but it counts as activity. Clients send one every 30 s while connected.
- `GET /healthz`: returns `ok`.

## Limits

| Limit | Value |
|---|---|
| Sockets per session | one `tv`, one `phone`; a new socket replaces the old one |
| Connects | 30 per minute per session (more: 4003) |
| Frame size | 300 KiB |
| Frame rate | 200 frames per 10 s per role, pings included; the window survives socket replacement |
| Bytes per session | 64 MiB forwarded in total (more: both sockets closed with 4003) |
| New sessions | 10 per minute per IP: an IPv4 address or an IPv6 /64 (joins and reconnects to a known session do not count) |
| Session lifetime | never paired: 15 minutes from creation; once both peers have connected: 60 minutes from creation |
| Idle timeout | 5 minutes without frames (pings count; connects do not) |
| Reconnect queue | 2 MiB and 60 s per waiting peer; 32 MiB across all sessions in an isolate, beyond which frames for absent peers are dropped |

The per-IP limit is **per isolate**, so it is approximate: Cloudflare runs many isolates and each
keeps its own count in memory. No shared store ever holds IPs, by design (the Workers Rate Limiting
binding would need an account-level setup). The limiter key is HMAC-SHA256 of the IPv4 address or
IPv6 /64 under a random per-isolate key, truncated to 16 bytes; raw IPs are never held, and stale
keys are pruned a few at a time on every check. **CGNAT:** many users can share one IPv4 address
(mobile carriers, some ISPs), so they also share the 10-per-minute budget. Joins and reconnects to a
known session are free, so this only limits creating new pairings.

### Origins

Origins listed in `ALLOWED_ORIGINS` (`wrangler.toml`) may connect with either role. A missing Origin,
`Origin: null` or `file://` is allowed only for `role=tv` (packaged TV apps). A bad `role` with a
missing or `null` Origin gets HTTP 403 rather than a 4004 close.

The Origin check is hygiene, not a security control: any non-browser client can send any Origin.
Security comes from the end-to-end encryption (the relay only ever sees ciphertext) and the limits
above.

## Close codes

| Code | Meaning |
|---|---|
| 4000 | session expired (reason `expired` or `idle`) |
| 4001 | replaced by a newer socket of the same role |
| 4002 | frame too large |
| 4003 | rate limit, too many connects, or the session byte quota (reason `quota`) |
| 4004 | bad role |
| 1003 | a text frame was sent (binary only) |

Clients treat 4000 to 4004 and 1003 as final. They never reconnect on 4001 (another socket of the
same role took over).

## Privacy notes

- **TTLs are best-effort.** All session state lives in memory, so a Durable Object that is evicted
  or restarted loses its timers along with everything else. The TV enforces its own pairing and
  session lifetimes and does not rely on the relay to end them.
- **The session id is in the URL path.** Cloudflare zone HTTP logs, Logpush or `wrangler tail`
  could record it together with the client IP. The relay itself logs nothing (observability is off),
  but keep zone-level HTTP request logging and Logpush **off** for the relay's hostname, and do not
  leave `wrangler tail` running in production.

## Code layout

- `src/sessionCore.ts`: pure session logic (forwarding, queue, limits, timers), unit-tested with a
  fake clock in `test/sessionCore.test.ts` (part of `pnpm test`).
- `src/limits.ts`: limits, close codes, session id, origin, per-IP (HMAC, /64) and queue-budget helpers.
- `src/worker.ts`: routing, Origin rules, the per-IP limit and the `Session` Durable Object.

## Development

```sh
pnpm relay:dev        # wrangler dev, fully local (Miniflare) on 127.0.0.1:8787; no account needed
pnpm relay:test:int   # integration checks against the running relay
```

`pnpm relay:dev` shortens the never-paired TTL to 60 s (`--var RELAY_TTL_UNPAIRED_MS:60000`) so the
expiry can be tested. The relay also reads `RELAY_TTL_MAX_MS` and `RELAY_IDLE_MS`. Only the dev
script sets these; unset or invalid values mean the production limits above.

`pnpm relay:test:int` runs `scripts/integration.mjs`. It expects `pnpm relay:dev` to be running
(it waits up to 30 s for `/healthz`), uses random synthetic session ids and frames, checks
forwarding both ways, the reconnect queue, replacement (4001), oversized frames (4002), bad role
(4004, or 403 without an Origin), Origin refusal (unlisted, `null` or missing for a phone), that a
ping is not forwarded, the session id format, and that a never-paired session is closed with 4000
after the TTL (about 60 s; set `RELAY_TTL_UNPAIRED_MS` for the script if the relay uses another
value). It exits non-zero on any failure. Set `RELAY_URL` to point it elsewhere. It is not part of
`pnpm test`.

Each run opens 6 new sessions and takes over a minute, so back-to-back runs stay under the per-IP
new-session limit (10 per minute).

## Production

`pnpm relay:deploy` runs `wrangler deploy --env production` and needs a Cloudflare account.
`[env.production]` in `wrangler.toml` does not inherit the dev `[vars]`, so the dev origins and
timer overrides never reach production. Before the first deploy:

1. Set `ALLOWED_ORIGINS` under `[env.production.vars]` to the companion's real origin (the
   placeholder is `https://manage.example.com`).
2. Add any hosted TV origins (for example a Titan OS or other hosted web TV build) to the same
   comma-separated list. Packaged Tizen and webOS builds send `Origin: null` or `file://` and need no
   entry.
3. Keep zone HTTP request logging and Logpush off for the relay hostname (see Privacy notes).
