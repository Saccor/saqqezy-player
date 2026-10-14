import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  FRAME_HEADER_BYTES,
  FRAME_IV_BYTES,
  MAX_CHUNK_CIPHERTEXT,
  MAX_CHUNK_PLAINTEXT,
  openFrame,
  Reassembler,
  sealMessage,
  toB64Url,
  type Direction,
  type FrameHeader,
} from '../src/index.ts';
import { REASSEMBLY_TIMEOUT_MS } from '../src/frames.ts';

const KIB = 1024;
const MIB = 1024 * 1024;

async function newKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const SID = new Uint8Array(16).map((_, i) => i + 1);

/** A JSON value whose JSON.stringify output is exactly `n` UTF-8 bytes (n === 2 gives `{}`). */
function jsonOfSize(n: number): unknown {
  if (n === 2) return {};
  const overhead = '{"d":""}'.length;
  return { d: 'x'.repeat(n - overhead) };
}

function randomB64(bytes: number): string {
  const b = new Uint8Array(bytes);
  for (let off = 0; off < bytes; off += 65536) crypto.getRandomValues(b.subarray(off, Math.min(bytes, off + 65536)));
  return toB64Url(b);
}

const hasCompression = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function roundTrip(
  key: CryptoKey, dir: Direction, msgId: number, value: unknown, order?: (n: number) => number[], compress = false,
): Promise<{ frames: Uint8Array[]; result: unknown }> {
  const frames = await sealMessage(key, SID, dir, msgId, value, { compress });
  const r = new Reassembler();
  const idx = order ? order(frames.length) : frames.map((_, i) => i);
  let result: unknown;
  for (let i = 0; i < idx.length; i++) {
    const frame = frames[idx[i]!]!;
    const { header, plaintextChunk } = await openFrame(key, SID, dir, frame);
    const out = await r.push(header, plaintextChunk);
    if (i < idx.length - 1) expect(out).toBeUndefined();
    else result = out;
  }
  return { frames, result };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wire format', () => {
  test('version ‖ flags ‖ msgId(u32 BE) ‖ index(u16 BE) ‖ count(u16 BE) ‖ iv(12) ‖ ciphertext+tag', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const key = await newKey();
    const frames = await sealMessage(key, SID, 'tv->phone', 0x01020304, { a: 1 });
    expect(frames.length).toBe(1);
    const f = frames[0]!;
    expect(FRAME_HEADER_BYTES).toBe(10);
    expect(FRAME_IV_BYTES).toBe(12);
    expect(f[0]).toBe(1); // version
    expect(f[1]).toBe(0); // flags: not compressed
    expect(Array.from(f.subarray(2, 6))).toEqual([1, 2, 3, 4]);
    expect(Array.from(f.subarray(6, 8))).toEqual([0, 0]); // index
    expect(Array.from(f.subarray(8, 10))).toEqual([0, 1]); // count
    const plainLen = JSON.stringify({ a: 1 }).length;
    expect(f.length).toBe(10 + 12 + plainLen + 16);
  });

  test('IVs are random per frame', async () => {
    const key = await newKey();
    const a = (await sealMessage(key, SID, 'tv->phone', 1, {}))[0]!;
    const b = (await sealMessage(key, SID, 'tv->phone', 1, {}))[0]!;
    expect(toB64Url(a.subarray(10, 22))).not.toBe(toB64Url(b.subarray(10, 22)));
  });

  test.skipIf(!hasCompression)('tv->phone with compress: true sets the compressed flag', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 7, jsonOfSize(KIB), { compress: true }))[0]!;
    expect(f[1]).toBe(1);
    // 1 KiB of 'x' compresses well
    expect(f.length).toBeLessThan(200);
  });

  test.skipIf(!hasCompression)('no compression by default, even when CompressionStream exists', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 7, jsonOfSize(KIB)))[0]!;
    expect(f[1]).toBe(0);
  });

  test.skipIf(!hasCompression)('phone->tv is never compressed, even with compress: true', async () => {
    const key = await newKey();
    const frames = await sealMessage(key, SID, 'phone->tv', 7, jsonOfSize(KIB), { compress: true });
    expect(frames.length).toBe(1);
    expect(frames[0]![1]).toBe(0);
    expect(frames[0]!.length).toBe(10 + 12 + KIB + 16);
  });

  test('openFrame rejects a bad direction as a programming error, not a decryption failure', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 1, {}))[0]!;
    await expect(openFrame(key, SID, 'sideways' as Direction, f)).rejects.toThrow('bad direction');
    await expect(openFrame(key, SID, 'sideways' as Direction, new Uint8Array(3))).rejects.toThrow('bad direction');
  });

  test('rejects invalid msgId and unserialisable values', async () => {
    const key = await newKey();
    await expect(sealMessage(key, SID, 'tv->phone', -1, {})).rejects.toThrow();
    await expect(sealMessage(key, SID, 'tv->phone', 2 ** 32, {})).rejects.toThrow();
    await expect(sealMessage(key, SID, 'tv->phone', 1.5, {})).rejects.toThrow();
    await expect(sealMessage(key, SID, 'tv->phone', 1, undefined)).rejects.toThrow();
    await expect(sealMessage(key, new Uint8Array(15), 'tv->phone', 1, {})).rejects.toThrow();
  });
});

describe('seal and open round trip', () => {
  const sizes: [string, number][] = [
    ['{} (0-byte body)', 2],
    ['1 KiB', KIB],
    ['exactly 256 KiB', 256 * KIB],
    ['256 KiB + 1', 256 * KIB + 1],
  ];

  for (const [label, n] of sizes) {
    test.skipIf(!hasCompression)(`${label}, compressed`, async () => {
      const key = await newKey();
      const value = jsonOfSize(n);
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBe(n);
      const { frames, result } = await roundTrip(key, 'tv->phone', 42, value, undefined, true);
      for (const f of frames) expect(f[1]).toBe(1);
      expect(result).toEqual(value);
      for (const f of frames) expect(f.length - FRAME_HEADER_BYTES - FRAME_IV_BYTES).toBeLessThanOrEqual(MAX_CHUNK_CIPHERTEXT);
    });

    test(`${label}, uncompressed: chunk count is exact`, async () => {
      vi.stubGlobal('CompressionStream', undefined);
      const key = await newKey();
      const value = jsonOfSize(n);
      const { frames, result } = await roundTrip(key, 'phone->tv', 43, value);
      expect(result).toEqual(value);
      expect(frames.length).toBe(Math.ceil(n / MAX_CHUNK_PLAINTEXT));
      frames.forEach((f, i) => {
        expect(f[1]).toBe(0);
        expect((f[6]! << 8) | f[7]!).toBe(i);
        expect((f[8]! << 8) | f[9]!).toBe(frames.length);
        expect(f.length - FRAME_HEADER_BYTES - FRAME_IV_BYTES).toBeLessThanOrEqual(MAX_CHUNK_CIPHERTEXT);
      });
    });
  }

  test('chunk boundaries: 256 KiB of ciphertext max means 262128 plaintext bytes per chunk', async () => {
    expect(MAX_CHUNK_CIPHERTEXT).toBe(256 * KIB);
    expect(MAX_CHUNK_PLAINTEXT).toBe(256 * KIB - 16);
    vi.stubGlobal('CompressionStream', undefined);
    const key = await newKey();
    expect((await sealMessage(key, SID, 'tv->phone', 1, jsonOfSize(MAX_CHUNK_PLAINTEXT))).length).toBe(1);
    const two = await sealMessage(key, SID, 'tv->phone', 1, jsonOfSize(MAX_CHUNK_PLAINTEXT + 1));
    expect(two.length).toBe(2);
    expect(two[0]!.length - 22).toBe(MAX_CHUNK_CIPHERTEXT);
  });

  test.skipIf(!hasCompression)('3 MiB of incompressible random data (base64), compressed, out of order', async () => {
    const key = await newKey();
    const value = { blob: randomB64(3 * MIB) };
    const reverse = (n: number) => Array.from({ length: n }, (_, i) => n - 1 - i);
    const { frames, result } = await roundTrip(key, 'tv->phone', 9, value, reverse, true);
    expect(result).toEqual(value);
    const jsonLen = JSON.stringify(value).length;
    // compression cannot shrink random base64 below ~75 %, so many chunks are needed
    expect(frames.length).toBeGreaterThanOrEqual(Math.ceil((jsonLen * 0.7) / MAX_CHUNK_PLAINTEXT));
    expect(frames.length).toBeLessThanOrEqual(Math.ceil((jsonLen + 1024) / MAX_CHUNK_PLAINTEXT));
  }, 30_000);

  test('3 MiB uncompressed, shuffled order: exact chunk count', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const key = await newKey();
    const value = { blob: randomB64(3 * MIB) };
    const shuffle = (n: number) => {
      const a = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return a;
    };
    const { frames, result } = await roundTrip(key, 'phone->tv', 10, value, shuffle);
    expect(result).toEqual(value);
    expect(frames.length).toBe(Math.ceil(JSON.stringify(value).length / MAX_CHUNK_PLAINTEXT));
  }, 30_000);
});

describe('Reassembler', () => {
  test('interleaved messages complete independently', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const key = await newKey();
    const a = await sealMessage(key, SID, 'tv->phone', 1, jsonOfSize(300 * KIB));
    const b = await sealMessage(key, SID, 'tv->phone', 2, jsonOfSize(300 * KIB + 5));
    const r = new Reassembler();
    const open = (f: Uint8Array) => openFrame(key, SID, 'tv->phone', f);
    const a0 = await open(a[0]!); const b1 = await open(b[1]!); const b0 = await open(b[0]!); const a1 = await open(a[1]!);
    expect(await r.push(a0.header, a0.plaintextChunk)).toBeUndefined();
    expect(await r.push(b1.header, b1.plaintextChunk)).toBeUndefined();
    expect(await r.push(b0.header, b0.plaintextChunk)).toEqual(jsonOfSize(300 * KIB + 5));
    expect(await r.push(a1.header, a1.plaintextChunk)).toEqual(jsonOfSize(300 * KIB));
  });

  test('duplicate chunk does not complete a message early', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const key = await newKey();
    const fr = await sealMessage(key, SID, 'tv->phone', 1, jsonOfSize(300 * KIB));
    const r = new Reassembler();
    const c0 = await openFrame(key, SID, 'tv->phone', fr[0]!);
    expect(await r.push(c0.header, c0.plaintextChunk)).toBeUndefined();
    await expect(r.push(c0.header, c0.plaintextChunk)).rejects.toThrow();
  });

  test('rejects inconsistent headers', async () => {
    const r = new Reassembler();
    const h = (o: Partial<FrameHeader>): FrameHeader => ({ msgId: 5, index: 0, count: 3, compressed: false, ...o });
    expect(await r.push(h({}), new Uint8Array(1))).toBeUndefined();
    await expect(r.push(h({ index: 1, count: 4 }), new Uint8Array(1))).rejects.toThrow();
    const r2 = new Reassembler();
    expect(await r2.push(h({}), new Uint8Array(1))).toBeUndefined();
    await expect(r2.push(h({ index: 1, compressed: true }), new Uint8Array(1))).rejects.toThrow();
    await expect(new Reassembler().push(h({ index: 3 }), new Uint8Array(1))).rejects.toThrow();
    await expect(new Reassembler().push(h({ count: 0 }), new Uint8Array(1))).rejects.toThrow();
  });

  test('bounded memory: refuses a message larger than 8 MiB', async () => {
    const r = new Reassembler();
    // 33 chunks * 262128 > 8 MiB: refused up front from the declared count
    await expect(r.push({ msgId: 1, index: 0, count: 40, compressed: false }, new Uint8Array(10))).rejects.toThrow();
    // and a single chunk larger than allowed
    await expect(r.push({ msgId: 2, index: 0, count: 2, compressed: false }, new Uint8Array(MAX_CHUNK_PLAINTEXT + 1)))
      .rejects.toThrow();
  });

  test.skipIf(!hasCompression)('bounded memory: refuses a gzip bomb that inflates past 8 MiB', async () => {
    const key = await newKey();
    const big = { d: 'x'.repeat(9 * MIB) };
    // sealMessage itself refuses plaintext > 8 MiB, so compress by hand to simulate a hostile sender
    const raw = new TextEncoder().encode(JSON.stringify(big));
    const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    expect(gz.length).toBeLessThan(MAX_CHUNK_PLAINTEXT);
    const r = new Reassembler();
    await expect(r.push({ msgId: 1, index: 0, count: 1, compressed: true }, gz)).rejects.toThrow();
    await expect(sealMessage(key, SID, 'tv->phone', 1, big, { compress: true })).rejects.toThrow();
  }, 30_000);

  test.skipIf(!hasCompression)('bounded inflate: a high-ratio bomb aborts after the first 64 KiB input slices', async () => {
    // ~200 MiB of zeros gzips to ~200 KB (about 1000:1), which still fits in one chunk.
    const zeros = new Uint8Array(MIB);
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 200; i++) c.enqueue(zeros);
        c.close();
      },
    });
    const gz = new Uint8Array(await new Response(src.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    expect(gz.length).toBeLessThan(MAX_CHUNK_PLAINTEXT);
    expect(gz.length).toBeGreaterThan(3 * 64 * KIB);

    // Count how many compressed bytes the decompressor is actually fed.
    const Real = DecompressionStream;
    let fed = 0;
    class CountingDecompressionStream {
      readonly writable: WritableStream<Uint8Array>;
      readonly readable: ReadableStream<Uint8Array>;
      constructor(format: CompressionFormat) {
        const inner = new Real(format);
        const w = inner.writable.getWriter();
        this.readable = inner.readable;
        this.writable = new WritableStream<Uint8Array>({
          async write(chunk) {
            fed += chunk.length;
            await w.write(chunk);
          },
          close: () => w.close(),
          abort: (r) => w.abort(r),
        });
      }
    }
    vi.stubGlobal('DecompressionStream', CountingDecompressionStream);

    const r = new Reassembler();
    await expect(r.push({ msgId: 1, index: 0, count: 1, compressed: true }, gz)).rejects.toThrow('message too large');
    expect(fed).toBeGreaterThan(0);
    expect(fed).toBeLessThanOrEqual(2 * 64 * KIB);
  }, 60_000);

  test('at most 4 messages in flight: the oldest partial message is evicted', async () => {
    const r = new Reassembler();
    const h = (msgId: number, index: number): FrameHeader => ({ msgId, index, count: 2, compressed: false });
    const part = (s: string) => new TextEncoder().encode(s);
    for (let id = 1; id <= 5; id++) expect(await r.push(h(id, 0), part('{"a":'))).toBeUndefined();
    // msgId 1 was evicted, so its second half now starts a fresh partial message
    expect(await r.push(h(1, 1), part('1}'))).toBeUndefined();
    // msgId 5 is still there
    expect(await r.push(h(5, 1), part('5}'))).toEqual({ a: 5 });
  });

  test('a partial message older than 30 s is evicted', async () => {
    let now = 0;
    const r = new Reassembler({ now: () => now });
    const h = (msgId: number, index: number): FrameHeader => ({ msgId, index, count: 2, compressed: false });
    const part = (s: string) => new TextEncoder().encode(s);
    expect(REASSEMBLY_TIMEOUT_MS).toBe(30_000);
    expect(await r.push(h(1, 0), part('{"a":'))).toBeUndefined();
    expect(await r.push(h(2, 0), part('{"a":'))).toBeUndefined();
    expect(r.pendingCount).toBe(2);
    now = 29_999;
    expect(await r.push(h(2, 1), part('2}'))).toEqual({ a: 2 }); // still within 30 s
    now = 30_000;
    expect(await r.push(h(3, 0), part('{"a":'))).toBeUndefined();
    expect(r.pendingCount).toBe(1); // msgId 1 timed out
    // msgId 1's second half now starts a fresh partial message instead of completing a stale one
    expect(await r.push(h(1, 1), part('1}'))).toBeUndefined();
  });
});

describe('tampering', () => {
  test('flipping any bit in header, IV or ciphertext makes openFrame throw', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 77, {}))[0]!;
    await expect(openFrame(key, SID, 'tv->phone', f)).resolves.toBeDefined();
    for (let byte = 0; byte < f.length; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const t = f.slice();
        t[byte] = t[byte]! ^ (1 << bit);
        await expect(openFrame(key, SID, 'tv->phone', t), `byte ${byte} bit ${bit}`).rejects.toThrow();
      }
    }
  });

  test('truncated or extended frames throw', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 1, {}))[0]!;
    await expect(openFrame(key, SID, 'tv->phone', f.subarray(0, f.length - 1))).rejects.toThrow();
    await expect(openFrame(key, SID, 'tv->phone', f.subarray(0, 21))).rejects.toThrow();
    const ext = new Uint8Array(f.length + 1); ext.set(f);
    await expect(openFrame(key, SID, 'tv->phone', ext)).rejects.toThrow();
  });

  test('wrong direction throws', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 1, { a: 1 }))[0]!;
    await expect(openFrame(key, SID, 'phone->tv', f)).rejects.toThrow();
  });

  test('wrong sessionId throws', async () => {
    const key = await newKey();
    const f = (await sealMessage(key, SID, 'tv->phone', 1, { a: 1 }))[0]!;
    const other = SID.slice(); other[0] = other[0]! ^ 1;
    await expect(openFrame(key, other, 'tv->phone', f)).rejects.toThrow();
  });

  test('wrong key throws', async () => {
    const f = (await sealMessage(await newKey(), SID, 'tv->phone', 1, { a: 1 }))[0]!;
    await expect(openFrame(await newKey(), SID, 'tv->phone', f)).rejects.toThrow();
  });

  test('swapping chunks between positions throws (index is authenticated)', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const key = await newKey();
    const fr = await sealMessage(key, SID, 'tv->phone', 1, jsonOfSize(300 * KIB));
    const moved = fr[1]!.slice();
    moved[7] = 0; // claim index 0
    await expect(openFrame(key, SID, 'tv->phone', moved)).rejects.toThrow();
  });
});

describe('no compression available', () => {
  test('flag is 0 and the round trip still works', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    expect(typeof CompressionStream).toBe('undefined');
    const key = await newKey();
    const value = { list: Array.from({ length: 50 }, (_, i) => ({ id: `ch-${i}`, name: `Channel ${i}` })) };
    const { frames, result } = await roundTrip(key, 'phone->tv', 3, value);
    for (const f of frames) expect(f[1]).toBe(0);
    expect(result).toEqual(value);
  });
});
