import { describe, expect, test } from 'vitest';
import { fnv1a } from '../src/hash.ts';
import { splitLines } from '../src/text/lines.ts';
import { normalize } from '../src/text/normalize.ts';
import { redactUrl } from '../src/errors.ts';

async function* chunks(...parts: string[]) { for (const p of parts) yield p; }
async function collect<T>(it: AsyncIterable<T>) { const out: T[] = []; for await (const x of it) out.push(x); return out; }

describe('fnv1a', () => {
  test('is stable and 8 hex chars', () => {
    expect(fnv1a('http://example.test/1')).toBe(fnv1a('http://example.test/1'));
    expect(fnv1a('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });
});

describe('splitLines', () => {
  test('joins lines split across chunks and handles CRLF', async () => {
    expect(await collect(splitLines(chunks('ab\r\ncd', 'ef\nlast')))).toEqual(['ab', 'cdef', 'last']);
  });
  test('strips a leading BOM and skips nothing else', async () => {
    expect(await collect(splitLines(chunks('﻿#EXTM3U\n\nx')))).toEqual(['#EXTM3U', '', 'x']);
  });
});

describe('normalize', () => {
  test('lowercases and strips diacritics', () => {
    expect(normalize('Åkerö TV Ünïcode')).toBe('akero tv unicode');
  });
});

describe('redactUrl', () => {
  test('hides xtream path credentials and query credentials', () => {
    expect(redactUrl('http://example.test:8080/live/user1/pass1/42.ts')).toBe('http://example.test:8080/live/***/***/42.ts');
    expect(redactUrl('http://example.test/player_api.php?username=u&password=p&action=x'))
      .toBe('http://example.test/player_api.php?username=***&password=***&action=x');
  });
  test('hides credentials in the Xtream short form /{user}/{pass}/{id}', () => {
    expect(redactUrl('http://example.test:8080/user1/pass1/42')).toBe('http://example.test:8080/***/***/42');
    expect(redactUrl('http://example.test/user1/pass1/42?token=1')).toBe('http://example.test/***/***/42?token=1');
  });
  test('hides credentials in the short form with a .ts or .m3u8 extension', () => {
    expect(redactUrl('http://example.test:8080/user1/pass1/42.ts')).toBe('http://example.test:8080/***/***/42.ts');
    expect(redactUrl('http://example.test/user1/pass1/42.m3u8?token=1')).toBe('http://example.test/***/***/42.m3u8?token=1');
  });
  test('leaves other three-segment paths alone', () => {
    expect(redactUrl('http://example.test/a/b/c')).toBe('http://example.test/a/b/c');
    expect(redactUrl('http://example.test/a/b/42.mp4')).toBe('http://example.test/a/b/42.mp4');
    expect(redactUrl('http://example.test/a/b/x.ts')).toBe('http://example.test/a/b/x.ts');
    expect(redactUrl('http://example.test/x/a/b/42')).toBe('http://example.test/x/a/b/42');
    expect(redactUrl('http://example.test/a/42')).toBe('http://example.test/a/42');
  });
  test('returns non-URLs unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
