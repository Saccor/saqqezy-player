import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SourceNetworkError } from '../src/errors.ts';
import { responseText } from '../src/net/textStream.ts';

async function collect(it: AsyncIterable<string>) { let s = ''; for await (const c of it) s += c; return s; }

describe('responseText', () => {
  test('decodes plain utf-8', async () => {
    expect(await collect(responseText(new Response('Åtta ✓'), 'http://example.test/a.m3u'))).toBe('Åtta ✓');
  });
  test('gunzips by magic bytes even without .gz or content type', async () => {
    const res = new Response(gzipSync(Buffer.from('<tv>Åtta</tv>')));
    expect(await collect(responseText(res, 'http://example.test/xmltv.php'))).toBe('<tv>Åtta</tv>');
  });
  test('does not gunzip a plain body served with a .gz url', async () => {
    const res = new Response('plain text', { headers: { 'content-type': 'application/gzip' } });
    expect(await collect(responseText(res, 'http://example.test/list.m3u.gz'))).toBe('plain text');
  });
  test('gunzips when the first chunk is a single byte', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from('tiny-first-chunk')));
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(gz.slice(0, 1)); c.enqueue(gz.slice(1)); c.close(); },
    });
    expect(await collect(responseText(new Response(body), 'http://example.test/x'))).toBe('tiny-first-chunk');
  });
  test('cancels the upstream body when the consumer exits early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new TextEncoder().encode('chunk')); },
      cancel() { cancelled = true; },
    });
    const it = responseText(new Response(body), 'http://example.test/x');
    await it.next();
    await it.return(undefined);
    expect(cancelled).toBe(true);
  });
  test('throws on missing body', async () => {
    await expect(collect(responseText(new Response(null), 'http://example.test/x'))).rejects.toThrow('empty');
  });

  describe('older TV engines (no DecompressionStream / TextDecoderStream)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    test('decodes plain utf-8 split across chunks without TextDecoderStream', async () => {
      vi.stubGlobal('TextDecoderStream', undefined);
      const bytes = new TextEncoder().encode('Åtta ✓');
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1, 3)); c.enqueue(bytes.slice(3)); c.close(); },
      });
      expect(await collect(responseText(new Response(body), 'http://example.test/x'))).toBe('Åtta ✓');
    });
    test('a gzip body without DecompressionStream fails with a clear network error', async () => {
      vi.stubGlobal('DecompressionStream', undefined);
      const res = new Response(gzipSync(Buffer.from('<tv/>')));
      const p = collect(responseText(res, 'http://example.test/xmltv.php'));
      await expect(p).rejects.toBeInstanceOf(SourceNetworkError);
      await expect(collect(responseText(new Response(gzipSync(Buffer.from('<tv/>'))), 'http://example.test/x')))
        .rejects.toThrow('compressed');
    });
  });
});
