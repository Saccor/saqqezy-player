import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
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
  test('throws on missing body', async () => {
    await expect(collect(responseText(new Response(null), 'http://example.test/x'))).rejects.toThrow('empty');
  });
});
