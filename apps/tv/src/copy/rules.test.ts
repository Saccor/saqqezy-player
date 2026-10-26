import { describe, expect, it } from 'vitest';
import { MAX_LINE, collectCopy, copyViolations } from './rules.ts';

const v = (text: string, exceptions = {}) => copyViolations([{ path: 'X.y', text }], exceptions).map((x) => x.rule);

describe('copy rules (spec 2026-10-26 §1.4)', () => {
  it('a single-line message is at most 70 characters unless it has a named exception', () => {
    expect(MAX_LINE).toBe(70);
    expect(v('a'.repeat(70))).toEqual([]);
    expect(v('a'.repeat(71))).toEqual(['length']);
    expect(v('a'.repeat(71), { 'X.y': ['length'] })).toEqual([]);
  });
  it('retires playlist, provider, EPG, "From start", "Could not", "Retry"/"Retry now" and "Ok"', () => {
    expect(v('Your playlist is empty')).toEqual(['playlist']);
    expect(v('From your own provider')).toEqual(['provider']);
    expect(v('TV guide (EPG) URL')).toEqual(['epg']);
    expect(v('From start')).toEqual(['fromStart']);
    expect(v('From the start')).toEqual([]);
    expect(v('Movies could not be loaded.')).toEqual(['couldNot']);
    expect(v('Retry now')).toEqual(['retry']);
    expect(v('Retry')).toEqual(['retry']);
    expect(v('Try again')).toEqual([]);
    expect(v('Ok plays')).toEqual(['okKey']);
  });
  it('menu paths use ›, never →', () => {
    expect(v('Settings → Sources')).toEqual(['arrowPath']);
    expect(v('Settings › Sources')).toEqual([]);
  });
  it('no key-hint text: footers, "Key: action" lines, (Left/Right), Press OK', () => {
    expect(v('Done saves · Back cancels')).toEqual(['keyHint']);
    expect(v('OK: Go live')).toEqual(['keyHint']);
    expect(v('Yellow: show')).toEqual(['keyHint']);
    expect(v('Subtitle delay: 0.5 s (Left/Right)')).toEqual(['keyHint']);
    expect(v('Press OK again to clear')).toEqual(['keyHint']);
    expect(v('Subtitle delay')).toEqual([]);
  });
  it('stays neutral (CLAUDE.md rule 3)', () => {
    expect(v('Free channels')).toEqual(['neutral']);
    expect(v('Freeing a connection…')).toEqual([]);
    expect(v('Cancel')).toEqual([]);
  });
  it('collects strings and the results of copy functions, with their paths', () => {
    const entries = collectCopy({ A: { x: 'One', f: (n: number) => `${n} folders`, nested: { y: 'Two' } } }, 'COPY');
    expect(entries).toEqual([
      { path: 'COPY.A.x', text: 'One' },
      { path: 'COPY.A.f', text: '88 folders' },
      { path: 'COPY.A.nested.y', text: 'Two' },
    ]);
  });
});
