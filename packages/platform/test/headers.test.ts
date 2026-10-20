import { describe, expect, test } from 'vitest';
import { headerSupport, headerUsable, type HeaderSupport } from '../src/headers.ts';

const ALL = { userAgent: true, referrer: true };
const NONE = { userAgent: false, referrer: false };
const UA = { userAgent: true, referrer: false };
const IDENTITY = { kind: 'identity' } as const;

describe('headerSupport (spec 2026-10-20-source-headers §2, §3)', () => {
  test('Samsung Tizen: lists none, streams User-Agent only (AVPlay)', () => {
    expect(headerSupport('tizen', IDENTITY)).toEqual({ lists: NONE, streams: UA });
  });

  test('LG webOS: none', () => {
    expect(headerSupport('webos', IDENTITY)).toEqual({ lists: NONE, streams: NONE });
  });

  test('desktop browser with the dev proxy: all; without a route: none', () => {
    expect(headerSupport('browser', { kind: 'dev' })).toEqual({ lists: ALL, streams: ALL });
    expect(headerSupport('browser', IDENTITY)).toEqual({ lists: NONE, streams: NONE });
  });

  test('PC and Android TV: native engines send both; lists need the host route', () => {
    expect(headerSupport('pc', { kind: 'prefix' })).toEqual({ lists: ALL, streams: ALL });
    expect(headerSupport('androidtv', { kind: 'prefix' })).toEqual({ lists: ALL, streams: ALL });
    expect(headerSupport('pc', IDENTITY)).toEqual({ lists: NONE, streams: ALL });
  });

  test('a route without media turns on lists only', () => {
    expect(headerSupport('browser', { kind: 'prefix', media: false })).toEqual({ lists: ALL, streams: NONE });
    expect(headerSupport('tizen', { kind: 'prefix', media: false })).toEqual({ lists: ALL, streams: UA });
  });
});

describe('headerUsable', () => {
  const tizen: HeaderSupport = { lists: NONE, streams: UA };
  test('a field is usable when any request kind can carry it', () => {
    expect(headerUsable(tizen, 'userAgent')).toBe(true);
    expect(headerUsable(tizen, 'referrer')).toBe(false);
    expect(headerUsable({ lists: NONE, streams: NONE }, 'userAgent')).toBe(false);
  });
});
