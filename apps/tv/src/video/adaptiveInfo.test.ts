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
  it('the SUB scaler (Tizen multiview): capped at 1080p whatever the panel', () => {
    expect(adaptiveInfo({ uhd: true, eightK: true, hdrTv: true }, { max1080: true })).toBe('STARTBITRATE=LOWEST|FIXED_MAX_RESOLUTION=1920X1080');
    expect(adaptiveInfo({ uhd: false, eightK: false, hdrTv: false }, { max1080: true })).toBe('STARTBITRATE=LOWEST|FIXED_MAX_RESOLUTION=1920X1080');
  });
});
