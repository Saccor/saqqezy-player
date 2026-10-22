import { describe, expect, it } from 'vitest';
import { deviceCountry, regionOf, type DeviceCountryGlobals } from './deviceCountry.ts';

const tizen = (value: { language?: string; country?: string } | 'error' | 'never' | 'throw'): DeviceCountryGlobals => ({
  tizen: {
    systeminfo: {
      getPropertyValue: (_p, ok, err) => {
        if (value === 'throw') throw new Error('x');
        if (value === 'error') err?.(new Error('x'));
        else if (value !== 'never') ok(value);
      },
    },
  },
});

describe('regionOf', () => {
  it('reads the region subtag of a locale tag', () => {
    expect(regionOf('sv-SE')).toBe('SE');
    expect(regionOf('sv_SE')).toBe('SE');
    expect(regionOf('zh-Hant-TW')).toBe('TW');
    expect(regionOf('en-gb')).toBe('GB');
    expect(regionOf('sv')).toBeUndefined();
    expect(regionOf('es-419')).toBeUndefined();
    expect(regionOf(undefined)).toBeUndefined();
  });
});

describe('deviceCountry', () => {
  it('Tizen LOCALE first (country, then language), as a code of the closed table', async () => {
    expect(await deviceCountry(tizen({ country: 'sv_SE', language: 'en_US' }), 'de-DE')).toBe('SE');
    expect(await deviceCountry(tizen({ language: 'da_DK' }), 'de-DE')).toBe('DK');
  });
  it('the browser language when Tizen is missing, fails, throws, never answers, or names no known country', async () => {
    expect(await deviceCountry({}, 'sv-SE')).toBe('SE');
    expect(await deviceCountry(tizen('error'), 'sv-SE')).toBe('SE');
    expect(await deviceCountry(tizen('throw'), 'sv-SE')).toBe('SE');
    expect(await deviceCountry(tizen('never'), 'sv-SE', 10)).toBe('SE');
    expect(await deviceCountry(tizen({ country: 'xx_XK' }), 'nb-NO')).toBe('NO');
  });
  it('UK is GB; nothing known gives undefined', async () => {
    expect(await deviceCountry({}, 'en-UK')).toBe('GB');
    expect(await deviceCountry({}, 'sv')).toBeUndefined();
    expect(await deviceCountry({}, '')).toBeUndefined();
  });
});
