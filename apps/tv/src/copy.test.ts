import { describe, expect, it } from 'vitest';
import { CATCHUP_COPY, FAV_COPY, favChangedToast, favToggleLabel } from './copy.ts';

describe('favourites copy', () => {
  it('is lowercase "favourites" everywhere, and the failure toast is one sentence', () => {
    for (const s of Object.values(FAV_COPY)) expect(s).toMatch(/favourites/);
    for (const s of Object.values(FAV_COPY)) expect(s).not.toMatch(/Favourites/);
    expect(FAV_COPY.failed).toBe("Couldn't change favourites.");
  });

  it('the menu label says what a press does; the toast says what is now true', () => {
    expect(favToggleLabel(false)).toBe('Add to favourites');
    expect(favToggleLabel(true)).toBe('Remove from favourites');
    expect(favChangedToast(true)).toBe('Added to favourites');
    expect(favChangedToast(false)).toBe('Removed from favourites');
  });
});

describe('catch-up copy', () => {
  /** CLAUDE.md rule 3: no piracy-flavoured or provider wording in UI text. */
  const BANNED = /\b(free|premium|vip|cancel|subscription|provider|seller|reseller|sports? league|ppv)\b/i;
  const all = () => {
    const out: string[] = [];
    for (const v of Object.values(CATCHUP_COPY)) if (typeof v === 'string') out.push(v);
    for (const n of [0, 1, 3]) out.push(CATCHUP_COPY.daysLeft(n), CATCHUP_COPY.tooOld(n));
    out.push(CATCHUP_COPY.nextTitle('Programme 4'));
    return out;
  };

  it('is neutral', () => {
    for (const s of all()) expect(s, s).not.toMatch(BANNED);
  });

  it('days left and too old read naturally', () => {
    expect(CATCHUP_COPY.daysLeft(2)).toBe('Catch-up · 2 days left');
    expect(CATCHUP_COPY.daysLeft(1)).toBe('Catch-up · 1 day left');
    expect(CATCHUP_COPY.daysLeft(0)).toBe('Catch-up · Last day');
    expect(CATCHUP_COPY.tooOld(3)).toBe('Not available: older than 3 days');
    expect(CATCHUP_COPY.notAvailable).toBe('Not available. Your source did not return this programme.');
  });
});
