import type { StreamInfo, SupervisorStatus } from '@iptv/player';

export type StreamVariant = 'ts' | 'm3u8' | 'other';

/**
 * The only parts of a stream URL the UI may show: the host (with port) and the format variant. Never the
 * path, query, fragment or user info, which can carry account credentials.
 */
export function describeStreamUrl(url: string | undefined): { host: string; variant: StreamVariant } {
  if (!url) return { host: 'unknown', variant: 'other' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { host: 'unknown', variant: 'other' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { host: 'unknown', variant: 'other' };
  const path = u.pathname.toLowerCase();
  const variant: StreamVariant = path.endsWith('.ts') ? 'ts' : path.endsWith('.m3u8') ? 'm3u8' : 'other';
  return { host: u.host || 'unknown', variant };
}

const DASH = '–';

export function formatBitrate(bps: number | undefined): string {
  if (!bps || bps <= 0) return DASH;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

function statusLabel(s: SupervisorStatus | undefined): string {
  if (!s) return 'Idle';
  switch (s.kind) {
    case 'loading': return 'Loading';
    case 'playing': return 'Playing';
    case 'reconnecting': return `Reconnecting (${s.attempt}/3)`;
    case 'failed': return `Failed (${s.reason})`;
  }
}

const VARIANT_LABEL: Record<StreamVariant, string> = { ts: 'TS', m3u8: 'HLS (m3u8)', other: 'Other' };

/** Label/value rows for the stream-info panel. */
export function streamInfoLines(info: StreamInfo, url: string | undefined, status: SupervisorStatus | undefined): [string, string][] {
  const { host, variant } = describeStreamUrl(url);
  const res = info.width && info.height
    ? `${info.width}×${info.height}${info.fps ? ` @ ${Math.round(info.fps)} fps` : ''}`
    : DASH;
  return [
    ['Resolution', res],
    ['Video', info.videoCodec ?? DASH],
    ['Audio', info.audioCodec ?? DASH],
    ['Bitrate', formatBitrate(info.bitrate)],
    ['Format', VARIANT_LABEL[variant]],
    ['Host', host],
    ['Status', statusLabel(status)],
  ];
}
