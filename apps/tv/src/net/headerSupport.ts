import { headerSupport, type HeaderSupport, type PlatformId } from '@iptv/platform';

/**
 * This build's header matrix (spec 2026-10-20-source-headers §2): the desktop browser in `vite dev` has the dev
 * proxy (all); production web builds fetch directly, so only the native engine's own options remain (AVPlay's
 * User-Agent on Tizen). The host route (`prefix`) arrives with the beta foundations.
 */
export function tvHeaderSupport(platform: PlatformId, dev: boolean): HeaderSupport {
  return headerSupport(platform, { kind: dev && platform === 'browser' ? 'dev' : 'identity' });
}
