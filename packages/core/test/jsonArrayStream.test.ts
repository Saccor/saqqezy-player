import { describe, expect, test } from 'vitest';
import { jsonArrayBatches } from '../src/net/jsonArrayStream.ts';

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}

async function collect(src: AsyncIterable<string>, batch?: number) {
  const out: { items: unknown[]; nonArray?: true }[] = [];
  for await (const b of jsonArrayBatches(src, batch ? { batch } : {})) out.push(b);
  return out;
}

const all = async (src: AsyncIterable<string>, batch?: number) => (await collect(src, batch)).flatMap((b) => b.items);

const tricky = [
  { id: 1, name: 'Brace } bracket ] comma , quote " end' },
  { id: 2, name: 'Back\\slash \\" and \\\\', tags: ['a', ['b', { c: '}' }]] },
  { id: 3, name: 'Unicode Ünïcødé 映画 🎬', nested: { deep: { deeper: [1, 2, { x: null }] } } },
  { id: 4, n: -1.5e3, t: true, f: false, z: null, e: '' },
  'plain string',
  42,
];
const text = JSON.stringify(tricky, null, 1);

describe('jsonArrayBatches', () => {
  test('one chunk: every element, in order', async () => {
    expect(await all(chunks(text))).toEqual(tricky);
  });

  test('split at every position: same result', async () => {
    for (let i = 0; i <= text.length; i++) {
      expect(await all(chunks(text.slice(0, i), text.slice(i)))).toEqual(tricky);
    }
  });

  test('one character per chunk', async () => {
    expect(await all(chunks(...text.split('')))).toEqual(tricky);
  });

  test('batches of the requested size; the last one holds the rest', async () => {
    const arr = Array.from({ length: 7 }, (_, i) => ({ i }));
    const got = await collect(chunks(JSON.stringify(arr)), 3);
    expect(got.map((b) => b.items.length)).toEqual([3, 3, 1]);
    expect(got.flatMap((b) => b.items)).toEqual(arr);
  });

  test('BOM and surrounding whitespace are skipped', async () => {
    expect(await all(chunks('﻿ \n\t[ {"a":1} ,\n {"b":2} ] \n'))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('an empty array yields nothing', async () => {
    expect(await collect(chunks('[]'))).toEqual([]);
    expect(await collect(chunks(' [ \n ] '))).toEqual([]);
  });

  test('a non-array answer is parsed whole and marked', async () => {
    expect(await collect(chunks('{"user_info":', '{"auth":0}}'))).toEqual([{ items: [{ user_info: { auth: 0 } }], nonArray: true }]);
    expect(await collect(chunks('null'))).toEqual([{ items: [null], nonArray: true }]);
  });

  test('an empty body yields nothing', async () => {
    expect(await collect(chunks(''))).toEqual([]);
    expect(await collect(chunks('  '))).toEqual([]);
  });

  test('not JSON, truncated or trailing garbage: SyntaxError', async () => {
    await expect(all(chunks('<html>not here</html>'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(all(chunks('[{"a":1},{"b":'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(all(chunks('[{"a":1}'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(all(chunks('[{"a":1}] x'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(all(chunks('[{"a":1},]'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(all(chunks('[{"a":1}}]'))).rejects.toBeInstanceOf(SyntaxError);
  });

  test('elements already yielded stay yielded before a later error', async () => {
    const seen: unknown[] = [];
    const run = async () => {
      for await (const b of jsonArrayBatches(chunks('[{"a":1},{"b":2},', '{"c":'), { batch: 1 })) seen.push(...b.items);
    };
    await expect(run()).rejects.toBeInstanceOf(SyntaxError);
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('large arrays stay linear (100k elements)', async () => {
    const arr = Array.from({ length: 100_000 }, (_, i) => ({ stream_id: i, name: `Synthetic Film ${i}`, category_id: String(i % 300) }));
    const s = JSON.stringify(arr);
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += 65_536) parts.push(s.slice(i, i + 65_536));
    const t0 = Date.now();
    const got = await all(chunks(...parts));
    expect(got.length).toBe(100_000);
    expect(got[99_999]).toEqual(arr[99_999]);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
