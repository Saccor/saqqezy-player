# Saqqezy Player: project rules

A fast, clean, neutral TV player for the user's own sources (M3U, Xtream, XMLTV EPG). It ships with no content.

**Hard rules: see [docs/GUARDRAILS.md](docs/GUARDRAILS.md) — never break them.** It holds the legal guardrails, the product principles and the architecture. If a request conflicts with these rules, stop and flag it to the user instead of implementing it.

## Workflow

- Write the core test-first. Parsers get fixture-based tests with synthetic playlists and EPG data.
- Sessions that edit code work in their own git worktree, never in the checkout a running dev server serves (every saved core/worker file reloads that page). To watch streams undisturbed, run `pnpm dev:stable`.
- The user communicates in English and sometimes Swedish. Write code and docs in English.
