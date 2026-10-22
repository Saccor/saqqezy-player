import { describe, expect, it } from 'vitest';
import { ConnectionLedger, hostOf } from '../src/index.ts';

const A = 'http://a.example.test:8080/live/u/p/1.ts';
const A2 = 'http://a.example.test:8080/live/u/p/2.ts';
const B = 'http://b.example.test/live/u/p/1.ts';

describe('ConnectionLedger', () => {
  it('counts the other sessions on the same source and host when a session begins', () => {
    const l = new ConnectionLedger({ now: () => 0 });
    expect(l.begin('s', A, 0).concurrent).toBe(0);
    expect(l.begin('s', A2, 1).concurrent).toBe(1);
    expect(l.begin('s', B, 2).concurrent).toBe(0); // another host
    expect(l.begin('other', A, 3).concurrent).toBe(0); // another source
    expect(l.concurrent('s')).toBe(3);
    expect(l.concurrent('s', hostOf(A))).toBe(2);
  });

  it('a closing session counts until closed() or 1.5 s', () => {
    let t = 0;
    const l = new ConnectionLedger({ now: () => t });
    const a = l.begin('s', A, 0).session;
    const b = l.begin('s', A, 1).session;
    a.playing();
    a.closing();
    b.closing();
    t = 1499;
    expect(l.concurrent('s')).toBe(2);
    b.closed();
    expect(l.concurrent('s')).toBe(1);
    t = 1500;
    expect(l.concurrent('s')).toBe(0);
  });

  it('never refuses a session, and remembers the most seen at once', () => {
    const l = new ConnectionLedger({ now: () => 0 });
    const sessions = Array.from({ length: 10 }, (_, i) => l.begin('s', A, i).session);
    expect(l.concurrent('s')).toBe(10);
    for (const s of sessions) s.closed();
    expect(l.concurrent('s')).toBe(0);
    expect(l.maxSeen('s')).toBe(10);
  });

  it('hostOf keeps host and port only, and never throws', () => {
    expect(hostOf(A)).toBe('a.example.test:8080');
    expect(hostOf('not a url')).toBe('');
  });
});
