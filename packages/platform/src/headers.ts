import type { PlatformId } from './keys.ts';

/** Every target the header matrix knows: the web platforms plus the native shells (beta plans). */
export type HeaderPlatform = PlatformId | 'pc' | 'androidtv';

/** Which of a source's headers a kind of request can carry. */
export interface HeaderFlags {
  userAgent: boolean;
  referrer: boolean;
}

/** What this device can send (spec 2026-10-20-source-headers §2). Fixed per launch. */
export interface HeaderSupport {
  /** Playlist, guide and API requests can carry the source's headers. */
  lists: HeaderFlags;
  /** Streams can carry them (best engine on this platform). */
  streams: HeaderFlags;
}

/**
 * How requests leave the app: `identity` (straight `fetch`, which cannot set either header), `dev` (the dev proxy)
 * or `prefix` (the on-device host route, foundations §2). `media: false` when the route does not serve streams.
 */
export interface HeaderRoute {
  kind: 'identity' | 'dev' | 'prefix';
  media?: boolean;
}

const BOTH: HeaderFlags = { userAgent: true, referrer: true };
const NONE: HeaderFlags = { userAgent: false, referrer: false };

/** The native engine's own header options: AVPlay `USER_AGENT` only; libmpv and Media3 both; web engines none. */
function nativeStreams(platform: HeaderPlatform): HeaderFlags {
  if (platform === 'tizen') return { userAgent: true, referrer: false };
  if (platform === 'pc' || platform === 'androidtv') return BOTH;
  return NONE;
}

/**
 * The header matrix for `platform` and its `route`: a dev or prefix route turns on lists, and streams for the web
 * engines when it serves media; the native engine adds what it can set itself.
 */
export function headerSupport(platform: HeaderPlatform, route: HeaderRoute): HeaderSupport {
  const routed = route.kind !== 'identity';
  const media = routed && route.media !== false;
  const native = nativeStreams(platform);
  return {
    lists: routed ? { ...BOTH } : { ...NONE },
    streams: { userAgent: media || native.userAgent, referrer: media || native.referrer },
  };
}

/** True when some request on this device can carry `field` (Advanced: the field is not dimmed). */
export function headerUsable(support: HeaderSupport, field: keyof HeaderFlags): boolean {
  return support.lists[field] || support.streams[field];
}
