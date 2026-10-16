import { describe, expect, it } from 'vitest';
import { COOLDOWN_TEXT, UNREACHABLE_TEXT, cooldownCopy } from './cooldownLogic.ts';

const NOW = 1_000_000;

describe('cooldownCopy', () => {
  it('shows nothing while clear', () => {
    expect(cooldownCopy({ state: 'clear' }, NOW, false)).toBeUndefined();
  });

  it('counts down whole minutes while waiting, with OK to retry', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 90_000, reason: 'refused' }, NOW, false))
      .toEqual({ text: COOLDOWN_TEXT, hint: 'Trying again in 2 min · OK: Retry now' });
    expect(cooldownCopy({ state: 'waiting', until: NOW + 1_000, reason: 'refused' }, NOW, false)?.hint)
      .toBe('Trying again in 1 min · OK: Retry now');
  });

  it('pointer mode says click', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 60_000, reason: 'refused' }, NOW, true)?.hint).toBe('Trying again in 1 min · Click to retry now');
  });

  it('uses the neutral copy', () => {
    expect(COOLDOWN_TEXT).toBe("Your source is refusing connections. The app is waiting so you don't get blocked.");
  });
});

describe('cooldownCopy by reason', () => {
  it('an unreachable source says it is not answering, with the same hint', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 300_000, reason: 'unreachable' }, NOW, false)).toEqual({
      text: "Your source isn't answering. The app is waiting so it doesn't flood it.",
      hint: 'Trying again in 5 min · OK: Retry now',
    });
    expect(UNREACHABLE_TEXT).toBe("Your source isn't answering. The app is waiting so it doesn't flood it.");
  });

  it('a refusal keeps the refusal text', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 60_000, reason: 'refused' }, NOW, true)?.text).toBe(COOLDOWN_TEXT);
  });
});
