# Core developer notes

- `pnpm test`: unit and integration tests (Vitest)
- `pnpm test:perf`: performance budgets (50k M3U < 2 s, XMLTV heap growth < 150 MB)
- `pnpm typecheck`: strict TypeScript across packages
- `pnpm fake-xtream`: local fake provider at http://127.0.0.1:8899
  - login: test / test
  - special usernames: expired, slow, error500

## Packages

- `@iptv/core`: pure logic.
  - `SourceService` is the entry point used by the TV Worker (Plan 2).
- `@iptv/storage`:
  - `IdbStorage` on TVs and in browsers
  - `MemoryStorage` in tests

## Rules

See `CLAUDE.md`. Test data stays synthetic. Credentials never reach logs or error text.
