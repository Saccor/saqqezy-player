# Security model

What the app protects, from whom, and how. To report a vulnerability, see [SECURITY.md](../SECURITY.md). The
architecture this builds on is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Assets and threats

| Asset | Where it lives |
|---|---|
| Playlist URLs (often with a token or login in the query) | IndexedDB on the TV |
| Xtream server, username and password | IndexedDB on the TV |
| Optional per-source User-Agent and Referer | IndexedDB on the TV |
| Lists, hidden channels, watch progress | IndexedDB on the TV; in encrypted backups |
| Companion pairing secrets | Memory only, on the TV and the phone, for one session |

Threats considered: our own servers (relay, trending) and their operator reading or keeping user data; a network
observer or anyone who can reach the relay reading, forging, replaying or redirecting companion messages; guessing
a pairing code; abuse of the relay (floods, oversized frames, session takeover); credentials leaking through logs,
error text or diagnostics; hostile input from playlists, API answers, guides and subtitle files.

## Client-only media

Our servers never see streams, playlists or guides. The TV downloads them from the user's hosts itself
([GUARDRAILS.md](GUARDRAILS.md) rules 6 and 7). The one proxy in the repo, `apps/tv/vite.proxy.ts`, exists so a
desktop browser can reach providers without CORS during development:

- It is a Vite plugin with `apply: 'serve'`, so it only exists inside `vite dev`, and it throws if
  `NODE_ENV=production`. In the production build `rawViaDevProxy` and `hlsViaDevProxy` are the identity.
- It refuses to start when `server.host` is anything other than `localhost`, `127.0.0.1` or `::1`.
- It sends no CORS headers and answers 403 to cross-site requests (`Sec-Fetch-Site`, or an `Origin` that is not
  the dev server's), so other sites cannot read through it. `GET` and `HEAD` only.
- Its log masks Xtream path credentials and every query value.

## What each server can see

**Relay** (`services/relay`, a Cloudflare Worker with one in-memory Durable Object per session):

- The session id (in the URL path), the role (`tv` or `phone`), the Origin header, the connecting IP (used
  transiently for the rate limit, see below), and the size and timing of every frame.
- Each frame's 10-byte header in clear: version, flags (including whether the payload is gzip-compressed), message
  id, chunk index and chunk count. These are authenticated but not encrypted.
- Not the content: no keys reach the relay, and frames are forwarded unchanged. It has no Durable Object storage
  and logs no frame contents, session ids or IPs (observability is off). Cloudflare zone logs or `wrangler tail`
  could record the URL with the IP, so the deployment notes say to keep them off for the relay host
  ([services/relay/README.md](../services/relay/README.md#privacy-notes)).

**Trending feed** (`services/trending`): nothing user-specific. The TV sends a bare
`GET /trending/v1/{movie|series}.{lang}.json` with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`: no
ids, no library data, no account. The feed is matched against the library on the device. Like any HTTP server,
Cloudflare sees the IP and the language in the path.

**Third parties the device talks to directly**: the user's own provider and guide hosts, and OpenSubtitles when the
user searches for subtitles (the query, or a file hash when exact matching is on, plus the app's API key, which is
built into the app). These are outside our control and out of scope.

## Companion pairing and encryption

Implemented in `packages/companion-protocol/src` (`pairing.ts`, `frames.ts`, `replay.ts`, `channel.ts`).

**Secrets.** Each pairing session has a 16-byte `sessionId` (public: the relay routes on it) and a 32-byte
AES-256-GCM key. The TV makes fresh secrets for every session and keeps them in memory only.

- **QR mode:** both values come from `crypto.getRandomValues`. The QR encodes
  `<companion origin>/#s=<b64url sessionId>&k=<b64url key>`. The fragment is never sent to a server; the companion
  strips it from the address bar with `history.replaceState` as soon as it reads it, and its page sets
  `<meta name="referrer" content="no-referrer">`.
- **Code mode:** a 12-character Crockford base32 code (`XXXX-XXXX-XXXX`, 60 bits from the CSPRNG, unbiased).
  Input is normalised (uppercase, dashes and spaces removed, `I`/`L` to `1`, `O` to `0`). One derivation gives both
  values: `PBKDF2-SHA256(code, salt "iptv-pair", 200,000 iterations, 48 bytes)`, bytes 0..16 the `sessionId`,
  16..48 the key. Deriving the public `sessionId` from the same slow output means an observer who sees it must pay
  the full 200,000 iterations per guess, the same as attacking the key. The salt is constant; that is acceptable
  because codes are random, single-use and live at most 15 minutes unpaired.
- Keys are imported or derived as **non-extractable** WebCrypto keys; raw key and code bytes are zeroed after
  import. Codes, keys and fragments are never logged.

**Frames.** A message is UTF-8 JSON, optionally gzip-compressed (TV to phone only; phone-to-TV frames are never
compressed and a compressed one is rejected before decryption), split into chunks. Each chunk is encrypted with
AES-256-GCM under a fresh random 12-byte IV and a 16-byte tag, at most 256 KiB of ciphertext per chunk. The
additional authenticated data is `sessionId (16) || direction (1) || msgId (u32) || index (u16) || count (u16) ||
version (1) || flags (1)`, so every header byte is authenticated, a frame cannot be moved to another session, and a
frame cannot be reflected back to its sender.

**Replay and ordering.** Message ids start at a random value below 2^31 and increase by one per message for the
whole session, including across reconnects (the same `SecureChannel` is kept; the channel closes rather than wrap
past 2^32 - 1). The receiver's `ReplayWindow` remembers the last 1,024 accepted ids per direction and keeps a
low-water mark: a repeat, or any id at or below the largest evicted id, is rejected. The check runs once per
completed message, after reassembly.

**Resource limits.** At most 8 MiB per message (as JSON and as compressed payload), 4 incomplete messages in
flight, and a partial message is dropped after 30 s. Decompression feeds 64 KiB slices and stops as soon as the
output passes the cap, so a gzip bomb costs a slice or two. Incoming messages are then validated against strict
type guards (`isPhoneToTv`), and source input from the phone is checked with the same rules as the on-TV form.

**Failure policy.** Before the first message is accepted, every bad frame counts, so a wrong key is detected during
pairing; five consecutive failures close the channel. After that, frames that fail to authenticate are dropped
silently and never count, so someone injecting garbage on the relay cannot end the session. Replays, validation
failures and reassembly errors after authentication still count.

**Lifetimes.** The TV enforces its own: an unpaired session ends 15 minutes after start, a paired one 60 minutes
after start, checked on every incoming message too (TV standby can delay timers). The relay's TTLs are best effort.

## Relay limits

| Limit | Value |
|---|---|
| Sockets | one `tv` and one `phone` per session; a new socket of a role replaces the old one (close 4001) |
| Session id | exactly 16 bytes as canonical base64url (22 characters) |
| Frame size | 300 KiB; binary frames only (a text frame closes with 1003) |
| Frame rate | 200 frames per 10 s per role, heartbeats included |
| Connects | 30 per minute per session |
| Bytes | 64 MiB forwarded per session |
| Lifetime | 15 min if never paired, 60 min from creation once both peers connected; 5 min idle timeout |
| Reconnect queue | 2 MiB and 60 s per waiting peer; 32 MiB per isolate across sessions |
| New sessions | 10 per minute per IPv4 address or IPv6 /64; joins and reconnects to a known session are free |

The new-session limit has two layers. Each isolate keeps an in-memory counter keyed by
`HMAC-SHA256(address prefix)` under a random per-isolate key, truncated to 16 bytes; raw IPs are never stored and
stale keys are pruned on every check. When the `NEW_SESSION_LIMITER` binding (Cloudflare Workers Rate Limiting) is
configured, as it is in `wrangler.toml`, the same limit is also applied across isolates, keyed by a truncated
SHA-256 of a fixed label and the address prefix. That key has to be the same in every isolate, so it is unkeyed; it
goes only to Cloudflare's counter, which already sees the connecting IP. A request must pass the in-memory
counter first; without the binding that count decides, and if the binding call fails the in-memory decision stands.
A refused new session gets HTTP 429.

## Credential handling

- Playlist URLs, Xtream logins and source headers are stored in IndexedDB on the device and sent only to the
  user's own hosts. They never go to the relay in clear or to the trending Worker.
- Error messages that cross from the worker to the UI or the companion go through `scrub()`, which removes query
  strings, fragments and Xtream path credentials from every URL (`redactUrl` in `packages/core/src/errors.ts`).
- The playback journal (Settings, Diagnostics) records decisions, never URLs or credentials. The dev proxy log
  masks credentials and query values.
- The companion sends a source's credentials to the TV inside encrypted frames, and a paired companion can read a
  source's settings back to edit them.
- Backups (`packages/core/src/sync`) never contain sources or credentials. They are sealed with AES-256-GCM under a
  key derived from a random 128-bit recovery code (PBKDF2-SHA256, 100,000 iterations by default, then HKDF).

## Known limitations and non-goals

- **The Origin check is hygiene, not a control.** The relay allows listed origins for both roles and a missing,
  `null` or `file://` Origin for `role=tv` (packaged TV apps). Any non-browser client can send any Origin. Security
  rests on the end-to-end encryption and the limits.
- **Rate limits are approximate.** The in-memory counter sees only its own isolate, the shared binding is skipped
  when it errors, and many users behind one CGNAT address share one budget for creating pairings.
- **Pairing secrets are bearer secrets.** Anyone who sees the QR code or the code on screen before it expires can
  pair and manage sources, including reading them back. There is no second confirmation on the TV.
- **Denial of service by a session id holder.** Someone who knows a session id can connect as a role and replace
  the legitimate socket, or use up the session's limits. They cannot read or forge messages, and the TV offers a
  new code.
- **Metadata.** The relay sees when a TV and phone talk, how much, and which IPs connect.
- **No encryption at rest.** Credentials in IndexedDB are protected only by the platform's per-app or per-origin
  storage. A compromised, rooted or unlocked device is out of scope.
- **Third-party hosts.** Providers, guide hosts and subtitle services see the device's requests, as any player's
  would.
