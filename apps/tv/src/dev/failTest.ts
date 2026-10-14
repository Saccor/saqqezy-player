import type { PlayableChannel } from '@iptv/app-api';

/**
 * DEV-only failure simulation: with `?failTest=1`, channel number 1 resolves to an unreachable URL (and no
 * alternate), so the supervisor goes through reconnecting to "unavailable". Only referenced behind
 * `import.meta.env.DEV`, so production builds drop this module entirely.
 */
export function withFailTest(ch: PlayableChannel | undefined): PlayableChannel | undefined {
  if (!ch || ch.number !== 1 || new URLSearchParams(location.search).get('failTest') !== '1') return ch;
  const { alternateUrl: _drop, ...rest } = ch;
  return { ...rest, url: 'http://127.0.0.1:1/x.ts' };
}
