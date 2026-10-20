import { describe, expect, it } from 'vitest';
import { hlsProxyPath, rewriteHls } from './rewriteHls.ts';

const BASE = 'http://cdn.example.test/live/stream/index.m3u8';

describe('rewriteHls', () => {
  it('returns an M3U channel list (no #EXT-X- tag) unchanged', () => {
    const list = '#EXTM3U\n#EXTINF:-1 tvg-id="a" tvg-logo="http://img.example.test/a.png",Channel A\nhttp://host.example.test/live/a.ts\n#EXTINF:-1,Channel B\nhttp://host.example.test/live/b.ts\n';
    expect(rewriteHls(list, BASE)).toBe(list);
  });

  it('wraps segments and key URIs of a media playlist', () => {
    const pl = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="http://keys.example.test/k1"\n#EXTINF:4,\nhttp://cdn.example.test/live/seg1.ts\n#EXT-X-ENDLIST';
    const out = rewriteHls(pl, BASE);
    expect(out).toContain(`URI="${hlsProxyPath('http://keys.example.test/k1')}"`);
    expect(out).toContain(hlsProxyPath('http://cdn.example.test/live/seg1.ts'));
    expect(out).toContain('/__proxy/hls/seg1.ts?u=');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('leaves data: and skd: URIs untouched', () => {
    const pl = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA"\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key-id"\n#EXTINF:4,\nseg.ts';
    const out = rewriteHls(pl, BASE);
    expect(out).toContain('URI="data:text/plain;base64,AAAA"');
    expect(out).toContain('URI="skd://key-id"');
  });

  it('resolves relative URIs against the base', () => {
    const pl = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg/a.ts\n#EXTINF:4,\n/abs/b.ts';
    const out = rewriteHls(pl, BASE);
    expect(out).toContain(hlsProxyPath('http://cdn.example.test/live/stream/seg/a.ts'));
    expect(out).toContain(hlsProxyPath('http://cdn.example.test/abs/b.ts'));
  });

  it('carries the source headers into every child URL: segments, keys, EXT-X-MEDIA, variants', () => {
    const h = { userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' };
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo/v.m3u8';
    const media = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://keys.example.test/k1"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.ts';
    const q = '&ua=SyntheticAgent%2F1.0&ref=http%3A%2F%2Fref.example.test%2F';
    const out = `${rewriteHls(master, BASE, h)}\n${rewriteHls(media, BASE, h)}`;
    const urls = out.match(/\/__proxy\/hls[^"\s]*/g) ?? [];
    expect(urls).toHaveLength(5);
    for (const u of urls) expect(u.endsWith(q)).toBe(true);
    expect(out).toContain(`${hlsProxyPath('http://cdn.example.test/live/stream/audio/a.m3u8')}${q}`);
  });

  it("without headers the rewritten URLs are exactly today's", () => {
    const pl = '#EXTM3U\n#EXTINF:4,\nseg1.ts';
    expect(rewriteHls(pl, BASE, {})).toBe(rewriteHls(pl, BASE));
    expect(rewriteHls(pl, BASE)).not.toContain('&ua=');
    expect(hlsProxyPath('http://cdn.example.test/a.ts', {})).toBe(hlsProxyPath('http://cdn.example.test/a.ts'));
  });
});
