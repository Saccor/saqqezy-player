import { describe, expect, it } from 'vitest';
import { HEADER_PARAM_MAX, headerQuery, readHeaderParams } from './headerParams.ts';

describe('headerQuery', () => {
  it('is empty without headers, so the route URL stays exactly as today', () => {
    expect(headerQuery(undefined)).toBe('');
    expect(headerQuery({})).toBe('');
    expect(headerQuery({ userAgent: '', referrer: '' })).toBe('');
  });

  it('adds ua and/or ref, encoded (spaces, &, non-ASCII)', () => {
    expect(headerQuery({ userAgent: 'Agent A/1.0 (x&y)' })).toBe('&ua=Agent%20A%2F1.0%20(x%26y)');
    expect(headerQuery({ referrer: 'http://ref.example.test/å?a=1&b=2' }))
      .toBe(`&ref=${encodeURIComponent('http://ref.example.test/å?a=1&b=2')}`);
    expect(headerQuery({ userAgent: 'A', referrer: 'B' })).toBe('&ua=A&ref=B');
  });
});

describe('readHeaderParams', () => {
  const read = (q: string) => readHeaderParams(new URLSearchParams(q));

  it('reads what headerQuery wrote', () => {
    const h = { userAgent: 'Agent A/1.0 (x&y)', referrer: 'http://ref.example.test/å?a=1&b=2' };
    expect(read(`u=x${headerQuery(h)}`)).toEqual(h);
    expect(read('u=x')).toEqual({});
  });

  it('rejects control characters and values over the cap', () => {
    expect(read(`ua=${encodeURIComponent('A\r\nX-Evil: 1')}`)).toBe('invalid');
    expect(read(`ref=${encodeURIComponent('a\u0000')}`)).toBe('invalid');
    expect(read(`ua=${'a'.repeat(HEADER_PARAM_MAX + 1)}`)).toBe('invalid');
    expect(read(`ua=${'a'.repeat(HEADER_PARAM_MAX)}`)).toEqual({ userAgent: 'a'.repeat(HEADER_PARAM_MAX) });
  });

  it('an empty value counts as absent', () => {
    expect(read('ua=&ref=')).toEqual({});
  });
});
