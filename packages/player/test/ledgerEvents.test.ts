import { describe, expect, it } from 'vitest';
import { ConnectionLedger, type LedgerEvent } from '../src/index.ts';

const A = 'http://a.example.test/live/u/p/1.ts';

describe('ConnectionLedger: events and snapshot', () => {
  it('reports begin, playing and a drop with how long the stream had played; never a URL', () => {
    let t = 1000;
    const l = new ConnectionLedger({ now: () => t });
    const events: LedgerEvent[] = [];
    l.onEvent((e) => events.push(e));
    const { session } = l.begin('s', A, 1);
    t = 2000;
    session.playing();
    t = 14_000;
    session.dropped('EOS');
    expect(events).toEqual([
      { k: 'begin', key: 's', host: 'a.example.test', tile: 1, at: 1000 },
      { k: 'playing', key: 's', host: 'a.example.test', tile: 1, at: 2000 },
      { k: 'dropped', key: 's', host: 'a.example.test', tile: 1, at: 14_000, code: 'EOS', playedMs: 12_000 },
    ]);
    expect(JSON.stringify(events)).not.toContain('/live/');
  });

  it('a session that never played drops with playedMs 0, and a drop counts as closing', () => {
    let t = 0;
    const l = new ConnectionLedger({ now: () => t });
    const events: LedgerEvent[] = [];
    l.onEvent((e) => events.push(e));
    const { session } = l.begin('s', A, 0);
    session.dropped('AUTH');
    expect(events.at(-1)).toMatchObject({ k: 'dropped', playedMs: 0 });
    t = 1500;
    expect(l.concurrent('s')).toBe(0);
  });

  it('snapshot lists the counted sessions of a source', () => {
    let t = 0;
    const l = new ConnectionLedger({ now: () => t });
    const a = l.begin('s', A, 0).session;
    t = 10;
    a.playing();
    l.begin('s', A, 1).session.closing();
    expect(l.snapshot('s')).toEqual([
      { tile: 0, host: 'a.example.test', since: 0, playingSince: 10, closing: false },
      { tile: 1, host: 'a.example.test', since: 10, closing: true },
    ]);
  });
});
