// Minimal hand-written ambient types for the Samsung Tizen globals. They exist only inside a packaged Tizen
// app (with the AVPlay / TV input privileges in config.xml); in a browser both are undefined, so always read
// them as `globalThis.tizen` / `globalThis.webapis` and check before use.
import type { TizenLike, WebapisLike } from '../platform/tizen.ts';

declare global {
  // eslint-disable-next-line no-var
  var tizen: TizenLike | undefined;
  // eslint-disable-next-line no-var
  var webapis: WebapisLike | undefined;
}

export {};
