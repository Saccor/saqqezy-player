import { describe, expect, it } from 'vitest';
import { CATCHUP_COPY, FAV_COPY, MULTIVIEW_COPY, favChangedToast, favToggleLabel } from './copy.ts';

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

describe('multiview copy', () => {
  const BANNED = /\b(free|premium|vip|cancel|subscription|provider|seller|reseller|sports? league|ppv)\b/i;

  it('is neutral, and calls a tile a window', () => {
    const all: string[] = [];
    for (const v of Object.values(MULTIVIEW_COPY)) if (typeof v === 'string') all.push(v);
    for (const n of [1, 2, 4]) {
      all.push(MULTIVIEW_COPY.infoReported(n), MULTIVIEW_COPY.kicked(n), MULTIVIEW_COPY.learned(n), MULTIVIEW_COPY.device(n), MULTIVIEW_COPY.setting(n));
    }
    for (const s of all) expect(s, s).not.toMatch(BANNED);
    expect(MULTIVIEW_COPY.closeWindow).toBe('Close window');
    expect(MULTIVIEW_COPY.addChannel).toBe('Add channel');
  });

  it('offers to watch a cut window instead, and says why a window stopped', () => {
    expect(MULTIVIEW_COPY.watchInstead).toBe('Watch this one instead');
    expect(MULTIVIEW_COPY.stoppedForOther).toBe('Stopped so another window can play.');
  });

  it('counts read naturally', () => {
    expect(MULTIVIEW_COPY.infoReported(1)).toBe('Your source reports 1 connection. Each window uses one.');
    expect(MULTIVIEW_COPY.infoReported(3)).toBe('Your source reports 3 connections. Each window uses one.');
    expect(MULTIVIEW_COPY.kicked(1)).toBe('Your source seems to allow 1 stream at once.');
    expect(MULTIVIEW_COPY.kicked(2)).toBe('Your source seems to allow 2 streams at once.');
    expect(MULTIVIEW_COPY.device(2)).toBe('This device can play 2 at once.');
    expect(MULTIVIEW_COPY.setting(2)).toBe('Max windows is set to 2 in Settings.');
  });
});
