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
  test('returns non-URLs unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
