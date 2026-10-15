import { describe, expect, it } from 'vitest';
import { LOCAL_FAKE_HOST, PAUSED_NOTE, createDevResumeGate, isLocalFake } from './devResume.ts';

const FAKE = 'http://127.0.0.1:8899/live/test/test/1.ts';
const REMOTE = 'http://source.example.test/live/u/p/1.ts';

describe('dev resume gate', () => {
  it('uses the spec copy and the fake source host', () => {
    expect(PAUSED_NOTE).toBe('Paused after reload: press OK to play');
    expect(LOCAL_FAKE_HOST).toBe('127.0.0.1:8899');
  });

  it('recognises only the local fake host', () => {
    expect(isLocalFake(FAKE)).toBe(true);
    expect(isLocalFake('http://localhost:8899/live/test/test/1.ts')).toBe(false);
    expect(isLocalFake(REMOTE)).toBe(false);
    expect(isLocalFake('not a url')).toBe(false);
  });

  it('production builds always resume', () => {
    const g = createDevResumeGate(false);
    expect(g.allows(REMOTE)).toBe(true);
    expect(g.paused()).toBe(false);
  });

  it('dev: the local fake source resumes after a page load', () => {
    const g = createDevResumeGate(true);
    expect(g.allows(FAKE)).toBe(true);
    expect(g.paused()).toBe(false);
  });

  it('dev: a remote source is held until the user starts a channel', () => {
    const g = createDevResumeGate(true);
    expect(g.allows(REMOTE)).toBe(false);
    expect(g.paused()).toBe(true);
    expect(g.allows(REMOTE)).toBe(false); // a later Home visit in the same page
    g.release();
    expect(g.paused()).toBe(false);
    expect(g.allows(REMOTE)).toBe(true);
  });
});
