import { describe, expect, it, vi } from 'vitest';
import { detectClient, formatCodeInput, isCodeComplete, takePairingFragment } from './pair.ts';

describe('takePairingFragment', () => {
  it('returns the fragment and strips it from the URL', () => {
    const replace = vi.fn();
    const frag = takePairingFragment({ hash: '#s=AAAA&k=BBBB', pathname: '/', search: '' }, replace);
    expect(frag).toBe('#s=AAAA&k=BBBB');
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('keeps the path and query when stripping', () => {
    const replace = vi.fn();
    takePairingFragment({ hash: '#k=B&s=A', pathname: '/app/', search: '?x=1' }, replace);
    expect(replace).toHaveBeenCalledWith('/app/?x=1');
  });

  it('returns null without s and k, but still strips any fragment', () => {
    const replace = vi.fn();
    expect(takePairingFragment({ hash: '#s=AAAA', pathname: '/', search: '' }, replace)).toBeNull();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('does nothing when there is no fragment', () => {
    const replace = vi.fn();
    expect(takePairingFragment({ hash: '', pathname: '/', search: '' }, replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('ignores empty s or k values', () => {
    expect(takePairingFragment({ hash: '#s=&k=B', pathname: '/', search: '' }, () => {})).toBeNull();
  });
});

describe('formatCodeInput', () => {
  it('uppercases and groups in fours', () => {
    expect(formatCodeInput('abcd')).toBe('ABCD');
    expect(formatCodeInput('abcde')).toBe('ABCD-E');
    expect(formatCodeInput('abcdefghjkmn')).toBe('ABCD-EFGH-JKMN');
  });

  it('drops spaces, dashes and other punctuation', () => {
    expect(formatCodeInput(' ab-cd efgh_jk.mn ')).toBe('ABCD-EFGH-JKMN');
  });

  it('caps the length at 12 characters', () => {
    expect(formatCodeInput('ABCDEFGHJKMNPQ')).toBe('ABCD-EFGH-JKMN');
  });

  it('keeps an empty input empty', () => {
    expect(formatCodeInput('')).toBe('');
    expect(formatCodeInput('---')).toBe('');
  });
});

describe('isCodeComplete', () => {
  it('is true only for a valid 12-character code', () => {
    expect(isCodeComplete('ABCD-EFGH-JKMN')).toBe(true);
    expect(isCodeComplete('abcd-efgh-jkmn')).toBe(true);
    expect(isCodeComplete('ABCD-EFGH-JKM')).toBe(false);
    expect(isCodeComplete('ABCD-EFGH-JKMU')).toBe(false); // U is not Crockford
  });
});

describe('detectClient', () => {
  const ua = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    androidPhone: 'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
    androidTablet: 'Mozilla/5.0 (Linux; Android 15; Tab) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    cros: 'Mozilla/5.0 (X11; CrOS x86_64 15000.0.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
  };

  it('labels phones', () => {
    expect(detectClient(ua.iphone)).toEqual({ kind: 'phone', label: 'iPhone' });
    expect(detectClient(ua.androidPhone)).toEqual({ kind: 'phone', label: 'Android phone' });
  });

  it('labels tablets as phone-kind companions', () => {
    expect(detectClient(ua.ipad)).toEqual({ kind: 'phone', label: 'iPad' });
    expect(detectClient(ua.androidTablet)).toEqual({ kind: 'phone', label: 'Android tablet' });
  });

  it('labels computers', () => {
    expect(detectClient(ua.windows)).toEqual({ kind: 'desktop', label: 'Windows PC' });
    expect(detectClient(ua.mac)).toEqual({ kind: 'desktop', label: 'Mac' });
    expect(detectClient(ua.linux)).toEqual({ kind: 'desktop', label: 'Linux PC' });
    expect(detectClient(ua.cros)).toEqual({ kind: 'desktop', label: 'Chromebook' });
  });

  it('detects iPadOS, which reports itself as a Mac, by its touch points', () => {
    expect(detectClient(ua.mac, 5)).toEqual({ kind: 'phone', label: 'iPad' });
  });

  it('falls back to a generic label', () => {
    expect(detectClient('')).toEqual({ kind: 'desktop', label: 'Web browser' });
  });
});
