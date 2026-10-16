import { describe, expect, it } from 'vitest';
import { createSourceLimit, maxConnectionsOf } from './sourceLimit.ts';

const xtream = (id: string, maxConnections?: number) => ({
  kind: 'xtream' as const, id, name: 'A', server: 'http://example.test', username: 'u', password: 'p',
  ...(maxConnections !== undefined ? { maxConnections } : {}),
});

describe('maxConnectionsOf', () => {
  it('is the Xtream account limit; M3U and unknown have none', () => {
    expect(maxConnectionsOf(xtream('s1', 2))).toBe(2);
    expect(maxConnectionsOf(xtream('s1'))).toBeUndefined();
    expect(maxConnectionsOf({ kind: 'm3u', id: 's2', name: 'B', playlistUrl: 'http://example.test/a.m3u' })).toBeUndefined();
    expect(maxConnectionsOf(undefined)).toBeUndefined();
  });
});

describe('createSourceLimit', () => {
  it('reads the active source and answers only for that source', async () => {
    const lim = createSourceLimit(async (id) => xtream(id, 3));
    expect(lim.of('s1')).toBeUndefined();
    await lim.load('s1');
    expect(lim.of('s1')).toBe(3);
    expect(lim.of('s2')).toBeUndefined();
  });

  it('a late answer for an older source never replaces a newer one', async () => {
    const answers: Record<string, (v: ReturnType<typeof xtream>) => void> = {};
    const lim = createSourceLimit((id) => new Promise((r) => { answers[id] = r; }));
    const a = lim.load('s1');
    const b = lim.load('s2');
    answers.s2!(xtream('s2', 1));
    await b;
    answers.s1!(xtream('s1', 4));
    await a;
    expect(lim.of('s2')).toBe(1);
    expect(lim.of('s1')).toBeUndefined();
  });

  it('a failed read keeps what it had; no source clears it', async () => {
    let fail = false;
    const lim = createSourceLimit(async (id) => {
      if (fail) throw new Error('x');
      return xtream(id, 2);
    });
    await lim.load('s1');
    fail = true;
    await lim.load('s1');
    expect(lim.of('s1')).toBe(2);
    await lim.load(undefined);
    expect(lim.of('s1')).toBeUndefined();
  });
});
