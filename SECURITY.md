# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue for a
security problem.

Include what you found, the affected component and commit, and the steps to reproduce it. You will get a
reply in the advisory thread. Fixes land on `main`; there are no maintained release branches.

## Supported scope

Only the current `main` branch is supported. It covers:

| Component | Path |
|---|---|
| TV app (browser build and Samsung Tizen `.wgt`) | `apps/tv`, `tools/tizen` |
| Companion phone app | `apps/companion` |
| Companion relay (Cloudflare Worker) | `services/relay` |
| Trending feed (Cloudflare Worker) | `services/trending` |
| Shared packages | `packages/*` |

## In scope

- **Companion pairing and end-to-end encryption** (`packages/companion-protocol`, `services/relay`).
  Pairing secrets come from a QR fragment or a one-time code (PBKDF2-SHA256), and every frame is sealed with
  AES-256-GCM on the devices. The relay only forwards opaque binary frames between one TV socket and one
  phone socket: it holds no keys, does not decrypt, and stores nothing. Anything that lets the relay or a
  network observer read, forge, replay or redirect frames, or that weakens the pairing secrets, is in scope.
- **Relay limits and abuse**: bypassing the per-session or per-IP limits, or taking over another session.
- **Credential storage**: playlist URLs and Xtream usernames and passwords are kept on the device only.
  Any path that sends them to our servers, logs them, or exposes them to other origins is in scope, as is
  the encryption of backups (`packages/core/src/sync`).
- **Parsing untrusted input**: XSS, script injection, prototype pollution, ReDoS or memory blow-ups from
  M3U playlists, Xtream API responses, XMLTV guides or subtitle files.
- **The trending Worker**: anything that makes it read or store data about the devices that fetch its
  public feed, or serve content it did not build.

## Out of scope

- Third-party streams, playlists, guides, portals and servers that users add as their own sources. The app
  ships with no content and does not operate any of them.
- Third-party services the app talks to (for example subtitle or metadata APIs) and the platforms
  themselves (Tizen, browsers, Cloudflare).
- Findings that need a rooted or already compromised device, or physical access to an unlocked TV.
- Missing hardening headers or best-practice notes without a concrete impact.
