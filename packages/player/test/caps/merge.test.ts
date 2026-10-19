import { describe, expect, it } from 'vitest';
import { capsSupport, learnAudio, learnedKey, mergeCaps, staticCaps } from '../../src/index.ts';

describe('mergeCaps', () => {
  it('probe overrides unknown and decode, but not a static none', () => {
    const base = staticCaps('webos', 'native');
    const m = mergeCaps(base, { audio: { dts: { value: 'decode', evidence: 'probe' }, truehd: { value: 'decode', evidence: 'probe' } } });
    expect(capsSupport(m, 'dts')).toBe('decode');
    expect(capsSupport(m, 'truehd')).toBe('none');
  });
  it('learned evidence overrides even a static none, and wins over probe', () => {
    const base = staticCaps('webos', 'native');
    const m = mergeCaps(base, { audio: { eac3: { value: 'decode', evidence: 'probe' } } }, { audio: { eac3: 'none', truehd: 'decode' } });
    expect(capsSupport(m, 'eac3')).toBe('none');
    expect(m.audio.eac3?.evidence).toBe('learned');
    expect(capsSupport(m, 'truehd')).toBe('decode');
  });
  it('does not mutate its inputs', () => {
    const base = staticCaps('tizen', 'avplay');
    const copy = JSON.stringify(base);
    mergeCaps(base, { audio: { dts: { value: 'decode', evidence: 'probe' } } }, { audio: { aac: 'none' } });
    expect(JSON.stringify(base)).toBe(copy);
  });
});
describe('learned', () => {
  it('learnedKey is stable and has no free text', () => {
    expect(learnedKey({ platform: 'tizen', engine: 'avplay', model: 'UE55 TU7000', firmware: 'T-KTM 1.2' })).toBe('tizen|avplay|UE55_TU7000|T-KTM_1.2');
    expect(learnedKey({ platform: 'desktop', engine: 'native' })).toBe('desktop|native||');
  });
  it('learnAudio returns a new record', () => {
    const a = learnAudio(undefined, 'dts', 'none');
    expect(learnAudio(a, 'ac3', 'none')).toEqual({ audio: { dts: 'none', ac3: 'none' } });
    expect(a).toEqual({ audio: { dts: 'none' } });
  });
});
