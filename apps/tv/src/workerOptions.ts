import { TV_EPG_BATCH } from '@iptv/core';
import type { PlatformId } from '@iptv/platform';

/**
 * Programmes per guide write for this platform (spec 2026-10-22-g9-stability §E): TVs write 1,000 at a time, so a
 * Guide read never waits long behind one; desktop and the browser keep core's default (undefined).
 */
export function guideBatchFor(platform: PlatformId): number | undefined {
  return platform === 'browser' || platform === 'desktop' ? undefined : TV_EPG_BATCH;
}
