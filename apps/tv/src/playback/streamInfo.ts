import type { VideoRange } from '@iptv/core';
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
    case 'reconnecting': return 'Reconnecting';
    case 'failed': return `Failed (${s.reason})`;
    case 'ended': return 'Ended';
  }
}

const VARIANT_LABEL: Record<StreamVariant, string> = { ts: 'TS', m3u8: 'HLS (m3u8)', other: 'Other' };

const RANGE_LABEL = { sdr: 'SDR', hdr10: 'HDR10', hdr10plus: 'HDR10+', hlg: 'HLG' } as const;
const FALLBACK_LABEL = { none: 'no HDR10 base', hdr10: 'HDR10 base', hlg: 'HLG base', sdr: 'SDR base' } as const;

/** The picture's range: the player's own DV reading first, then what the source or title says, then the player's. */
function hdrLabel(info: StreamInfo, hint: VideoRange | undefined): string | undefined {
  if (info.hdr === 'dv') return 'Dolby Vision';
  if (hint?.hdr === 'dv') {
    const name = hint.dvProfile !== undefined ? `Dolby Vision ${hint.dvProfile}` : 'Dolby Vision';
    return hint.dvFallback ? `${name} (${FALLBACK_LABEL[hint.dvFallback]})` : `${name} (title)`;
  }
  const r = hint?.hdr ?? info.hdr;
  return r ? RANGE_LABEL[r] : undefined;
}

/** Label/value rows for the stream-info panel. `hint`: the range the source or title gives (VOD). */
export function streamInfoLines(
  info: StreamInfo, url: string | undefined, status: SupervisorStatus | undefined, hint?: VideoRange,
): [string, string][] {
  const { host, variant } = describeStreamUrl(url);
  const res = info.width && info.height
    ? `${info.width}×${info.height}${info.fps ? ` @ ${Math.round(info.fps)} fps` : ''}`
    : DASH;
  const hdr = hdrLabel(info, hint);
  return [
    ['Resolution', res],
    ['Video', info.videoCodec ?? DASH],
    ...(hdr ? [['HDR', hdr] as [string, string]] : []),
    ['Audio', info.audioCodec ?? DASH],
    ['Bitrate', formatBitrate(info.bitrate)],
    ['Format', VARIANT_LABEL[variant]],
    ['Host', host],
    ['Status', statusLabel(status)],
  ];
}
