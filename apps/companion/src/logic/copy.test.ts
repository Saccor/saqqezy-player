import { describe, expect, it } from 'vitest';
import { COPY, endCopy, resultErrorCopy } from './copy.ts';

describe('endCopy', () => {
  it('maps an expired or idle session (relay 4000, or no welcome) to the expired copy', () => {
    expect(endCopy('expired')).toBe('This code has expired. Show a new code on your TV.');
    expect(endCopy('no-welcome')).toBe(COPY.expired);
    expect(endCopy('deadline')).toBe(COPY.expired);
  });

  it('maps 4001 to the replaced copy', () => {
    expect(endCopy('replaced')).toBe('This session was opened somewhere else.');
  });

  it('maps peer errors and protocol limits to "pair again"', () => {
    for (const r of ['peer-errors', 'rate-limit', 'quota', 'too-large', 'bad-role', 'protocol', 'queue-overflow', 'msgid-exhausted']) {
      expect(endCopy(r)).toBe('Connection problem – pair again.');
    }
  });

  it('maps an unreachable relay to the TV copy', () => {
    expect(endCopy('unreachable')).toBe("Can't reach the TV. Check that the TV is on and showing the code.");
  });

  it('has copy for the TV ending the session', () => {
    expect(endCopy('tv-bye')).toBe(COPY.tvEnded);
  });

  it('falls back to "pair again" for anything unknown', () => {
    expect(endCopy('something-new')).toBe(COPY.peerErrors);
  });
});

describe('resultErrorCopy', () => {
  it('uses the busy copy for Busy', () => {
    expect(resultErrorCopy({ name: 'Busy', message: 'whatever' })).toBe('The TV is busy. Try again.');
  });

  it('shows the TV message otherwise', () => {
    expect(resultErrorCopy({ name: 'ValidationError', message: 'Enter a server address.' })).toBe('Enter a server address.');
  });

  it('has a fallback for a missing or empty error', () => {
    expect(resultErrorCopy(undefined)).toBe(COPY.genericError);
    expect(resultErrorCopy({ name: 'X', message: '  ' })).toBe(COPY.genericError);
  });
});

describe('status copy', () => {
  it('has the exact wording for slow and silent TVs, invalid links and ended sessions', () => {
    expect(COPY.stillWorking).toBe('The TV is still working or not answering. Check the TV.');
    expect(COPY.rowWorking).toBe('Still working on the TV…');
    expect(COPY.notAnswering).toBe("The TV isn't answering.");
    expect(COPY.invalidLink).toBe('This link is not valid. Show a new code on your TV, or type the code below.');
    expect(COPY.sessionEnded).toBe('This session ended. Show a new code on your TV.');
  });
});
