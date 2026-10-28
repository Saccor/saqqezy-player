import { describe, expect, it } from 'vitest';
import { COOLDOWN_COPY } from '../copy/failure.ts';
import { COOLDOWN_TEXT, UNREACHABLE_TEXT, cooldownCopy } from './cooldownLogic.ts';

const NOW = 1_000_000;

describe('cooldownCopy', () => {
  it('shows nothing while clear', () => {
    expect(cooldownCopy({ state: 'clear' }, NOW)).toBeUndefined();
  });

  it('counts down whole minutes while waiting, with no key hint (OK and a click still retry)', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 90_000, reason: 'refused' }, NOW))
      .toEqual({ text: COOLDOWN_TEXT, hint: 'Trying again in 2 min' });
    expect(cooldownCopy({ state: 'waiting', until: NOW + 1_000, reason: 'refused' }, NOW)?.hint)
      .toBe('Trying again in 1 min');
  });

  it('uses the neutral copy', () => {
    expect(COOLDOWN_TEXT).toBe(COOLDOWN_COPY.refused);
  });
});

describe('cooldownCopy by reason', () => {
  it('an unreachable source says it is not answering, with the same hint', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 300_000, reason: 'unreachable' }, NOW)).toEqual({
      text: COOLDOWN_COPY.unreachable,
      hint: 'Trying again in 5 min',
    });
    expect(UNREACHABLE_TEXT).toBe(COOLDOWN_COPY.unreachable);
  });

  it('a refusal keeps the refusal text', () => {
    expect(cooldownCopy({ state: 'waiting', until: NOW + 60_000, reason: 'refused' }, NOW)?.text).toBe(COOLDOWN_TEXT);
  });
});
