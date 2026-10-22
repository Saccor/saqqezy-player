import { describe, expect, test } from 'vitest';
import { createVideoResources, tizenWindowCeiling } from './tizenMultiview.ts';

const UA_9 = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36';
const UA_6 = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';

const avplay = { enableAudioStream() {}, disableAudioStream() {} };
const capable = (version: unknown = '9.0') => ({
  tizen: { systeminfo: { getCapability: () => version } },
  webapis: { avplay, avplaystore: { getPlayer: () => ({}) } },
});

describe('tizenWindowCeiling', () => {
  test('2 on Tizen 7.0+ with avplaystore and per-instance audio', () => {
    expect(tizenWindowCeiling(capable('9.0'), UA_9)).toEqual({ windows: 2, reason: 'ok' });
    expect(tizenWindowCeiling(capable('7.0'), UA_9).windows).toBe(2);
    expect(tizenWindowCeiling(capable('10.0'), UA_9).windows).toBe(2);
  });

  test('1 below Tizen 7.0', () => {
    expect(tizenWindowCeiling(capable('6.5'), UA_9)).toEqual({ windows: 1, reason: 'version' });
  });

  test('the user agent version when systeminfo is missing or throws', () => {
    const noInfo = { webapis: capable().webapis };
    expect(tizenWindowCeiling(noInfo, UA_9).windows).toBe(2);
    expect(tizenWindowCeiling(noInfo, UA_6)).toEqual({ windows: 1, reason: 'version' });
    const throwing = { ...noInfo, tizen: { systeminfo: { getCapability: () => { throw new Error('x'); } } } };
    expect(tizenWindowCeiling(throwing, UA_9).windows).toBe(2);
    expect(tizenWindowCeiling(noInfo, 'Mozilla/5.0')).toEqual({ windows: 1, reason: 'version' });
  });

  test('1 without avplaystore or the audio stream calls', () => {
    expect(tizenWindowCeiling({ ...capable(), webapis: { avplay } }, UA_9)).toEqual({ windows: 1, reason: 'noStore' });
    expect(tizenWindowCeiling({ ...capable(), webapis: { avplay: {}, avplaystore: { getPlayer: () => ({}) } } }, UA_9))
      .toEqual({ windows: 1, reason: 'noAudioStream' });
    expect(tizenWindowCeiling({}, UA_9)).toEqual({ windows: 1, reason: 'noStore' });
  });
});

describe('createVideoResources', () => {
  test('MAIN first, then SUB, then none', () => {
    const r = createVideoResources();
    expect(r.claim()).toBe('MAIN');
    expect(r.claim()).toBe('SUB');
    expect(r.claim()).toBeUndefined();
  });

  test('a released scaler is handed out again, MAIN before SUB', () => {
    const r = createVideoResources();
    r.claim();
    r.claim();
    r.release('MAIN');
    expect(r.claim()).toBe('MAIN');
    r.release('SUB');
    r.release('MAIN');
    expect(r.claim()).toBe('MAIN');
    expect(r.claim()).toBe('SUB');
  });

  test('releasing a free scaler changes nothing', () => {
    const r = createVideoResources();
    r.release('SUB');
    expect(r.claim()).toBe('MAIN');
    expect(r.claim()).toBe('SUB');
  });
});
