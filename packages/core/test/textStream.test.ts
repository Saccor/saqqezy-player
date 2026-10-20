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
  test('aborts with a neutral error when no chunk arrives for idleMs, and cancels the body', async () => {
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent) return new Promise<void>(() => {}); // stalls forever
        sent = true;
        c.enqueue(new TextEncoder().encode('#EXTM3U\n'));
        return undefined;
      },
      cancel() { cancelled = true; },
    });
    const got: string[] = [];
    const err = await (async () => {
      for await (const t of responseText(new Response(body), 'http://example.test/x', { idleMs: 30 })) got.push(t);
    })().catch((e: unknown) => e);
    expect(got.join('')).toBe('#EXTM3U\n');
    expect(err).toBeInstanceOf(SourceNetworkError);
    expect((err as Error).message).toBe('The provider stopped sending data.');
    expect(cancelled).toBe(true);
  });
  test('the idle timeout also covers the first chunk', async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    await expect(collect(responseText(new Response(body), 'http://example.test/x', { idleMs: 20 })))
      .rejects.toThrow('The provider stopped sending data.');
  });
  test('a slow but steady body is not cut off', async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 15));
        if (n++ < 4) c.enqueue(new TextEncoder().encode('x'));
        else c.close();
      },
    });
    expect(await collect(responseText(new Response(body), 'http://example.test/x', { idleMs: 60 }))).toBe('xxxx');
  });
  test('an abort signal cancels the read', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel() { cancelled = true; } });
    const ac = new AbortController();
    const p = collect(responseText(new Response(body), 'http://example.test/x', { signal: ac.signal }));
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(SourceNetworkError);
    expect(cancelled).toBe(true);
  });
  test('throws on missing body', async () => {
    await expect(collect(responseText(new Response(null), 'http://example.test/x'))).rejects.toThrow('empty');
  });

  describe('character sets', () => {
    /** A body sent as these byte chunks. */
    const chunked = (...parts: (number[] | string)[]) => new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(typeof p === 'string' ? new Uint8Array(Buffer.from(p, 'latin1')) : new Uint8Array(p));
        c.close();
      },
    });
    const text = (body: ReadableStream<Uint8Array> | Uint8Array, headers?: Record<string, string>) =>
      collect(responseText(new Response(body, headers ? { headers } : {}), 'http://example.test/x'));
    const latin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

    test('a Latin-1 XMLTV body with its XML declaration decodes å, ä and ö', async () => {
      const xml = '<?xml version="1.0" encoding="ISO-8859-1"?>\n<tv><channel id="a"><display-name>Synthetic Kanal Åäö</display-name></channel></tv>';
      expect(await text(latin1(xml))).toBe(xml);
    });
    test('the XML declaration names the fallback character set', async () => {
      // 0xA4 is "€" in ISO-8859-15 but "¤" in windows-1252.
      const head = '<?xml version="1.0" encoding="ISO-8859-15"?>\n<tv>Price ';
      expect(await text(chunked(head, [0xa4], '</tv>'))).toBe(`${head}€</tv>`);
    });
    test('a charset in Content-Type names the fallback character set', async () => {
      expect(await text(chunked('#EXTM3U\n#EXTINF:-1,Price ', [0xa4, 0x0a]), { 'content-type': 'audio/x-mpegurl; charset="ISO-8859-15"' }))
        .toBe('#EXTM3U\n#EXTINF:-1,Price €\n');
    });
    test('a Latin-1 M3U without a declaration: the first non-ASCII byte after a long ASCII run decides', async () => {
      const ascii = '#EXTINF:-1,Synthetic Channel\nhttp://example.test/1.ts\n'.repeat(400);
      expect(await text(chunked(ascii.slice(0, 5000), ascii.slice(5000), '#EXTINF:-1,Synthetic Malmö\n'))).toBe(`${ascii}#EXTINF:-1,Synthetic Malmö\n`);
    });
    test('a Latin-1 byte at the end of a chunk that looks like a UTF-8 lead byte', async () => {
      // 0xE5 ("å") starts a 3-byte UTF-8 sequence; the next chunk proves it is not one.
      expect(await text(chunked('Synthetic ', [0xe5], 'ngel\n'))).toBe('Synthetic ångel\n');
    });
    test('UTF-8 split byte by byte stays UTF-8', async () => {
      const bytes = [...new TextEncoder().encode('Synthetic Åtta ✓ 😀\n')];
      expect(await text(chunked(...bytes.map((b) => [b])))).toBe('Synthetic Åtta ✓ 😀\n');
    });
    test('UTF-8 mislabelled as Latin-1 is read as UTF-8', async () => {
      expect(await text(new TextEncoder().encode('Synthetic Åtta'), { 'content-type': 'text/plain; charset=iso-8859-1' })).toBe('Synthetic Åtta');
      const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><tv>Åtta</tv>';
      expect(await text(new TextEncoder().encode(xml))).toBe(xml);
    });
    test('once real UTF-8 was seen, a later stray byte does not switch the character set', async () => {
      const utf8 = [...new TextEncoder().encode('Åtta ')];
      expect(await text(chunked(utf8, ' x '.repeat(100), [0xff], ' end'))).toBe(`Åtta ${' x '.repeat(100)}� end`);
    });
    test('UTF-8 with a stray byte in the same chunk as its first non-ASCII text stays UTF-8', async () => {
      const enc = (s: string) => [...new TextEncoder().encode(s)];
      expect(await text(new Uint8Array([...enc('Åtta Åtta '), 0xff, ...enc(' end')]))).toBe('Åtta Åtta � end');
    });
    test('byte order marks', async () => {
      expect(await text(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Åtta')]))).toBe('Åtta');
      expect(await text(new Uint8Array([0xff, 0xfe, ...Buffer.from('Åtta', 'utf16le')]))).toBe('Åtta');
      expect(await text(new Uint8Array([0xfe, 0xff, ...Buffer.from('Åtta', 'utf16le').swap16()]))).toBe('Åtta');
    });
    test('a Latin-1 byte as the very last byte', async () => {
      expect(await text(chunked('Synthetic ', [0xe5]))).toBe('Synthetic å');
    });
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
