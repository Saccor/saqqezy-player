import { describe, expect, test } from 'vitest';
import { cueAt, decodeSubtitle, parseSubtitles, SUBTITLE_MAX_BYTES } from '../src/subtitles/parse.ts';

// Synthetic subtitles written for these tests.
const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,000
<i>Two</i> lines
of text.

3
01:02:03,004 --> 01:02:05,000
Late cue.
`;

const VTT = `WEBVTT - test

NOTE a comment
that spans lines

STYLE
::cue { color: yellow }

intro
00:01.000 --> 00:02.500 align:start position:10%
First.

00:00:03.000 --> 00:00:04.000
<v Anna>Second</v> &amp; more
`;

describe('parseSubtitles', () => {
  test('SRT: times, text and tags stripped', () => {
    expect(parseSubtitles(SRT)).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello there.' },
      { startMs: 4000, endMs: 6000, text: 'Two lines\nof text.' },
      { startMs: 3723004, endMs: 3725000, text: 'Late cue.' },
    ]);
  });

  test('WebVTT: header, NOTE and STYLE skipped, cue ids and settings ignored, short times, entities', () => {
    expect(parseSubtitles(VTT)).toEqual([
      { startMs: 1000, endMs: 2500, text: 'First.' },
      { startMs: 3000, endMs: 4000, text: 'Second & more' },
    ]);
  });

  test('CRLF, a BOM, missing numbers, dot millis in SRT and SSA override tags', () => {
    const text = '﻿00:00:01.5 --> 00:00:02,000\r\n{\\an8}Top\r\n\r\n\r\n7\r\n00:00:03,000 --> 00:00:04,000\r\n<font color="#fff">Font</font>\r\n';
    expect(parseSubtitles(text)).toEqual([
      { startMs: 1500, endMs: 2000, text: 'Top' },
      { startMs: 3000, endMs: 4000, text: 'Font' },
    ]);
  });

  test('broken blocks are skipped; cues come out sorted by start', () => {
    const text = '1\n00:00:09,000 --> 00:00:10,000\nNine\n\n2\nnot a time\nJunk\n\n3\n00:00:02,000 --> 00:00:01,000\nBackwards\n\n4\n00:00:05,000 --> 00:00:06,000\n\n5\n00:00:01,000 --> 00:00:02,000\nOne\n';
    expect(parseSubtitles(text)).toEqual([
      { startMs: 1000, endMs: 2000, text: 'One' },
      { startMs: 9000, endMs: 10_000, text: 'Nine' },
    ]);
  });

  test('nothing usable gives an empty list', () => {
    expect(parseSubtitles('')).toEqual([]);
    expect(parseSubtitles('<html><body>Not found</body></html>')).toEqual([]);
  });
});

describe('cueAt', () => {
  const cues = parseSubtitles(SRT);

  test('the cue on screen at a time, or empty between cues', () => {
    expect(cueAt(cues, 0)).toBe('');
    expect(cueAt(cues, 1000)).toBe('Hello there.');
    expect(cueAt(cues, 3499)).toBe('Hello there.');
    expect(cueAt(cues, 3500)).toBe('');
    expect(cueAt(cues, 5000)).toBe('Two lines\nof text.');
    expect(cueAt(cues, 3724000)).toBe('Late cue.');
    expect(cueAt(cues, 9_999_999)).toBe('');
    expect(cueAt([], 1000)).toBe('');
  });

  test('overlapping cues show together, in start order', () => {
    const overlap = parseSubtitles('00:00:01,000 --> 00:00:10,000\nLong\n\n00:00:02,000 --> 00:00:03,000\nShort\n');
    expect(cueAt(overlap, 2500)).toBe('Long\nShort');
    expect(cueAt(overlap, 5000)).toBe('Long');
  });
});

describe('decodeSubtitle', () => {
  test('UTF-8, with or without a BOM', () => {
    const bytes = new TextEncoder().encode('Hej på dig');
    expect(decodeSubtitle(bytes)).toBe('Hej på dig');
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toBe('Hej på dig');
  });

  test('UTF-16 with a BOM', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0xe5, 0x00]);
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0xe5]);
    expect(decodeSubtitle(le)).toBe('Hå');
    expect(decodeSubtitle(be)).toBe('Hå');
  });

  test('not valid UTF-8: read as Windows-1252 (the common legacy Western encoding)', () => {
    // "Hej på dig" in Windows-1252: å is 0xE5.
    expect(decodeSubtitle(new Uint8Array([0x48, 0x65, 0x6a, 0x20, 0x70, 0xe5, 0x20, 0x64, 0x69, 0x67]))).toBe('Hej på dig');
  });

  test('a size cap that keeps a wrong file from filling memory', () => {
    expect(SUBTITLE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
