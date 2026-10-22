import { describe, expect, test } from 'vitest';
import { createChunkCodec } from '../src/compress.ts';

const text = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ t: `Synthetic Film ${i}`, p: 'https://img.example.test/p/' })));

describe('chunk codec', () => {
  test('gzip where CompressionStream exists, and it is smaller', async () => {
    const codec = createChunkCodec(globalThis);
    const enc = await codec.encode(text);
    expect(enc.enc).toBe('gzip');
    expect(enc.bytes.byteLength).toBeLessThan(text.length / 4);
    expect(await codec.decode(enc)).toBe(text);
  });

  test('plain UTF-8 without CompressionStream', async () => {
    const codec = createChunkCodec({});
    const enc = await codec.encode('Ålänning ✓');
    expect(enc.enc).toBe('none');
    expect(await codec.decode(enc)).toBe('Ålänning ✓');
  });

  test('a TV with compression still reads a plain chunk', async () => {
    const plain = await createChunkCodec({}).encode(text);
    expect(await createChunkCodec(globalThis).decode(plain)).toBe(text);
  });

  test('a gzip chunk on a TV without DecompressionStream is an error, not garbage', async () => {
    const gz = await createChunkCodec(globalThis).encode(text);
    await expect(createChunkCodec({}).decode(gz)).rejects.toThrow(/gzip/);
  });
});
