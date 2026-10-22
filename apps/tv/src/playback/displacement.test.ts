import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '@iptv/player';
import { createDisplacementDetector } from './displacement.ts';

const host = 'a.example.test';
// `session` defaults to the label: one stream per label unless a test says otherwise.
const begin = (tile: number, at: number, session = tile): LedgerEvent => ({ k: 'begin', key: 's', host, tile, at, session });
const playing = (tile: number, at: number, session = tile): LedgerEvent => ({ k: 'playing', key: 's', host, tile, at, session });
const dropped = (tile: number, at: number, playedMs: number, code = 'EOS', session = tile): LedgerEvent =>
  ({ k: 'dropped', key: 's', host, tile, at, code, playedMs, session });

describe('createDisplacementDetector', () => {
  it('a window that played steadily and drops within 8 s of another opening was displaced', () => {
    const d = createDisplacementDetector();
    d.feed(begin(0, 0));
    d.feed(playing(0, 1000));
    expect(d.feed(begin(1, 20_000))).toBeUndefined();
    expect(d.feed(dropped(0, 23_000, 22_000))).toEqual({ k: 'displaced', key: 's', host, victim: 0, byTile: 1, afterMs: 3000, concurrentBefore: 1 });
  });

  it('no displacement: played under 10 s, dropped 8 s or more after the open, or another host', () => {
    const d = createDisplacementDetector();
    d.feed(begin(1, 20_000));
    expect(d.feed(dropped(0, 21_000, 9_000))).toBeUndefined();
    expect(d.feed(dropped(2, 28_000, 60_000))).toBeUndefined();
    expect(d.feed({ k: 'dropped', key: 's', host: 'b.example.test', tile: 3, at: 21_000, code: 'EOS', playedMs: 60_000, session: 3 })).toBeUndefined();
    expect(d.feed(dropped(1, 21_500, 60_000))).toBeUndefined(); // the window that opened is not displaced by itself
  });

  it('two windows that keep failing alternately: stop the one that began last', () => {
    const d = createDisplacementDetector();
    d.feed(begin(0, 0));
    d.feed(begin(1, 1000));
    expect(d.feed(dropped(0, 2000, 0))).toBeUndefined();
    expect(d.feed(dropped(1, 3000, 0))).toBeUndefined();
    expect(d.feed(dropped(0, 4000, 0))).toEqual({ k: 'pingPong', key: 's', host, stop: 1 });
  });

  it('alternate failures spread over more than 60 s are not ping-pong', () => {
    const d = createDisplacementDetector();
    d.feed(begin(0, 0));
    d.feed(begin(1, 1000));
    d.feed(dropped(0, 2000, 0));
    d.feed(dropped(1, 40_000, 0));
    expect(d.feed(dropped(0, 70_000, 0))).toBeUndefined();
  });

  it('a scripted kick-oldest source with the response applied stays bounded', () => {
    // The source cuts the oldest stream at every open. The response stops the newest window and lets the cut one
    // reconnect once; nothing else opens by itself.
    const d = createDisplacementDetector();
    let t = 0;
    let begins = 0;
    const open = (tile: number) => { begins++; return d.feed(begin(tile, t)); };
    open(0);
    d.feed(playing(0, (t += 1000)));
    t += 20_000;
    open(1);
    d.feed(playing(1, (t += 1000)));
    const verdict = d.feed(dropped(0, (t += 1000), 21_000)); // the source cut window 0
    expect(verdict?.k).toBe('displaced');
    // Response: window 1 stops (never retried), window 0 reconnects once.
    d.feed(dropped(1, (t += 10), 1010, 'stop'));
    open(0);
    d.feed(playing(0, (t += 1000)));
    expect(begins).toBeLessThanOrEqual(4);
  });

  it('ignores a stream that reuses a label: a label belongs to its latest stream', () => {
    // Two streams under label 0 (a slot labelled the same as another): the older one's events cannot be told apart
    // from the newer one's, so they are left out; the newer one is detected as usual.
    const d = createDisplacementDetector();
    d.feed(begin(0, 0, 10));
    d.feed(playing(0, 1000, 10));
    d.feed(begin(0, 15_000, 11));
    d.feed(playing(0, 16_000, 11));
    d.feed(begin(1, 30_000, 12));
    expect(d.feed(dropped(0, 31_000, 30_000, 'EOS', 10))).toBeUndefined();
    // Nor do its drops count towards two windows taking turns.
    expect(d.feed(dropped(1, 32_000, 0, 'EOS', 12))).toBeUndefined();
    expect(d.feed(dropped(0, 33_000, 0, 'EOS', 10))).toBeUndefined();
    // The label's latest stream still counts: it played steadily and the source cut it after window 1 opened.
    const e = createDisplacementDetector();
    e.feed(begin(0, 0, 10));
    e.feed(begin(0, 1000, 11));
    e.feed(playing(0, 2000, 11));
    e.feed(begin(1, 20_000, 12));
    expect(e.feed(dropped(0, 23_000, 21_000, 'EOS', 11))).toMatchObject({ k: 'displaced', victim: 0, byTile: 1 });
  });
});
