import { describe, expect, it } from 'vitest';
import { adaptiveInfo } from './adaptiveInfo.ts';

describe('adaptiveInfo', () => {
  it('FHD panel: start low only', () => {
    expect(adaptiveInfo({ uhd: false, eightK: false, hdrTv: false })).toBe('STARTBITRATE=LOWEST');
  });
  it('UHD panel: one string, keys joined with |', () => {
    expect(adaptiveInfo({ uhd: true, eightK: false, hdrTv: true })).toBe('STARTBITRATE=LOWEST|FIXED_MAX_RESOLUTION=3840X2160');
  });
  it('8K panel', () => {
    expect(adaptiveInfo({ uhd: true, eightK: true, hdrTv: true })).toBe('STARTBITRATE=LOWEST|FIXED_MAX_RESOLUTION=7680X4320');
  });
});
