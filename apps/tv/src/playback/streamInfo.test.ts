import { describe, expect, it } from 'vitest';
import { describeStreamUrl, formatBitrate, streamInfoLines } from './streamInfo.ts';

const SECRET_URL = 'http://alice:s3cret@tv.example.test:8080/live/alice/s3cret/1234.ts?token=abc#frag';

describe('describeStreamUrl', () => {
  it('keeps only host and variant', () => {
    expect(describeStreamUrl(SECRET_URL)).toEqual({ host: 'tv.example.test:8080', variant: 'ts' });
    expect(describeStreamUrl('https://cdn.example.test/live/u/p/9.m3u8?x=1')).toEqual({ host: 'cdn.example.test', variant: 'm3u8' });
    expect(describeStreamUrl('https://cdn.example.test/stream/9')).toEqual({ host: 'cdn.example.test', variant: 'other' });
  });

  it('never leaks anything for unparsable input', () => {
    expect(describeStreamUrl('not a url /user/pass.ts')).toEqual({ host: 'unknown', variant: 'other' });
    expect(describeStreamUrl(undefined)).toEqual({ host: 'unknown', variant: 'other' });
  });
});

describe('formatBitrate', () => {
  it('formats bits per second', () => {
    expect(formatBitrate(4_200_000)).toBe('4.2 Mbps');
    expect(formatBitrate(800_000)).toBe('800 kbps');
    expect(formatBitrate(undefined)).toBe('–');
    expect(formatBitrate(0)).toBe('–');
  });
});

describe('streamInfoLines', () => {
  it('lists resolution, codecs, bitrate, variant, host and status without path or credentials', () => {
    const lines = streamInfoLines(
      { width: 1280, height: 720, videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2', bitrate: 2_500_000, fps: 25 },
      SECRET_URL,
      { kind: 'reconnecting', attempt: 2 },
    );
    expect(lines).toEqual([
      ['Resolution', '1280×720 @ 25 fps'],
      ['Video', 'avc1.64001f'],
      ['Audio', 'mp4a.40.2'],
      ['Bitrate', '2.5 Mbps'],
      ['Format', 'TS'],
      ['Host', 'tv.example.test:8080'],
      ['Status', 'Reconnecting'],
    ]);
    const all = JSON.stringify(lines);
    for (const bad of ['alice', 's3cret', 'live', '1234', 'token', 'abc', 'frag']) expect(all).not.toContain(bad);
  });

  it('fills unknown values with a dash', () => {
    const lines = streamInfoLines({}, 'https://cdn.example.test/a/b.m3u8', undefined);
    expect(lines).toEqual([
      ['Resolution', '–'],
      ['Video', '–'],
      ['Audio', '–'],
      ['Bitrate', '–'],
      ['Format', 'HLS (m3u8)'],
      ['Host', 'cdn.example.test'],
      ['Status', 'Idle'],
    ]);
  });

  it('adds an HDR row when the player or the source knows the range', () => {
    const hdr = (...a: Parameters<typeof streamInfoLines>) => streamInfoLines(...a).find((l) => l[0] === 'HDR')?.[1];
    expect(hdr({}, undefined, undefined)).toBeUndefined();
    expect(hdr({ hdr: 'hdr10' }, undefined, undefined)).toBe('HDR10');
    expect(hdr({}, undefined, undefined, { hdr: 'hlg' })).toBe('HLG');
    expect(hdr({}, undefined, undefined, { hdr: 'dv', dvProfile: 5, dvFallback: 'none' })).toBe('Dolby Vision 5 (no HDR10 base)');
    expect(hdr({}, undefined, undefined, { hdr: 'dv', dvProfile: 8, dvFallback: 'hdr10' })).toBe('Dolby Vision 8 (HDR10 base)');
    expect(hdr({}, undefined, undefined, { hdr: 'dv' })).toBe('Dolby Vision (title)');
    // The player's own DV reading wins over the source's HDR10.
    expect(hdr({ hdr: 'dv' }, undefined, undefined, { hdr: 'hdr10' })).toBe('Dolby Vision');
    const lines = streamInfoLines({ videoCodec: 'HEVC' }, undefined, undefined, { hdr: 'sdr' });
    expect(lines.slice(0, 3)).toEqual([['Resolution', '–'], ['Video', 'HEVC'], ['HDR', 'SDR']]);
  });

  it('names failures without detail', () => {
    const lines = streamInfoLines({}, undefined, { kind: 'failed', reason: 'unsupported' });
    expect(lines.at(-1)).toEqual(['Status', 'Failed (unsupported)']);
    expect(lines.find((l) => l[0] === 'Host')).toEqual(['Host', 'unknown']);
  });
});
