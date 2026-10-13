import { describe, expect, test } from 'vitest';
import { EpgMatcher, applyShift, epgKey, inWindow, nowNext } from '../src/epg/window.ts';
import type { Channel, Programme } from '../src/types.ts';

const H = 3600_000;
const now = Date.UTC(2026, 9, 13, 12);
const p = (startH: number, stopH: number, title = `${startH}`): Programme => ({ epgId: 'e', start: now + startH * H, stop: now + stopH * H, title });
const ch = (name: string, epgId?: string): Channel => ({ id: name, sourceId: 's', name, url: 'http://example.test', group: 'G', number: 1, ...(epgId ? { epgId } : {}) });

describe('inWindow', () => {
  test('keeps programmes overlapping [-6h, +48h]', () => {
    expect(inWindow(p(-8, -7), now)).toBe(false);
    expect(inWindow(p(-7, -5), now)).toBe(true);
    expect(inWindow(p(47, 49), now)).toBe(true);
    expect(inWindow(p(48, 49), now)).toBe(false);
  });
});

describe('nowNext', () => {
  test('finds current and following programme regardless of order', () => {
    const r = nowNext([p(1, 2, 'later'), p(-1, 0.5, 'current'), p(0.5, 1, 'next')], now);
    expect(r.now?.title).toBe('current');
    expect(r.next?.title).toBe('next');
  });
  test('gap: no current, next is the first upcoming', () => {
    const r = nowNext([p(1, 2, 'upcoming'), p(-3, -2, 'past')], now);
    expect(r.now).toBeUndefined();
    expect(r.next?.title).toBe('upcoming');
  });
});

describe('EpgMatcher', () => {
  test('matches by epg id, then by display name, otherwise drops', () => {
    const channels = [ch('Channel 001', 'ch1.test'), ch('Nyheter Åtta'), ch('Channel 003', 'unused.id')];
    const m = new EpgMatcher(channels);
    m.addXmltvChannel('ch1.test', ['Whatever']);
    m.addXmltvChannel('xml.atta', ['NYHETER ATTA']);
    m.addXmltvChannel('xml.003', ['channel 003']);
    m.addXmltvChannel('xml.none', ['Nobody']);
    expect(m.resolve('ch1.test')).toBe('ch1.test');
    expect(m.resolve('xml.atta')).toBe('name:nyheter atta');
    expect(m.resolve('xml.003')).toBe('unused.id');
    expect(m.resolve('xml.none')).toBeUndefined();
    expect(m.resolve('never.declared')).toBeUndefined();
    expect(epgKey(channels[1]!)).toBe('name:nyheter atta');
  });
});

describe('applyShift', () => {
  test('returns a shifted copy', () => {
    const p: Programme = { epgId: 'a', start: 1000, stop: 5000, title: 'T' };
    const q = applyShift(p, 2);
    expect(q).toEqual({ epgId: 'a', start: 1000 + 7_200_000, stop: 5000 + 7_200_000, title: 'T' });
    expect(q).not.toBe(p);
    expect(p.start).toBe(1000);
    expect(applyShift(p, -0.5).start).toBe(1000 - 1_800_000);
    expect(applyShift(p, 0)).toEqual(p);
  });
});
