import { describe, expect, it } from 'vitest';
import { COOLDOWN_TEXT, cooldownCopy } from './cooldownLogic.ts';

const NOW = 1_000_000;

describe('cooldownCopy', () => {
  it('shows nothing while clear', () => {
    expect(cooldownCopy({ state: 'clear' }, NOW, false)).toBeUndefined();
  });

  it('counts down whole minutes while waiting, with OK to retry', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 90_000 }, NOW, false))
      .toEqual({ text: COOLDOWN_TEXT, hint: 'Trying again in 2 min · OK: Retry now' });
    expect(cooldownCopy({ state: 'waiting', until: NOW + 1_000 }, NOW, false)?.hint)
      .toBe('Trying again in 1 min · OK: Retry now');
  });

  it('manual only: just Retry; pointer mode says click', () => {
    expect(cooldownCopy({ state: 'manual' }, NOW, false)?.hint).toBe('OK: Retry');
    expect(cooldownCopy({ state: 'manual' }, NOW, true)?.hint).toBe('Click to retry');
    expect(cooldownCopy({ state: 'waiting', until: NOW + 60_000 }, NOW, true)?.hint).toBe('Trying again in 1 min · Click to retry now');
  });

  it('uses the neutral copy', () => {
    expect(COOLDOWN_TEXT).toBe("Your source is refusing connections. The app is waiting so you don't get blocked.");
  });
});
