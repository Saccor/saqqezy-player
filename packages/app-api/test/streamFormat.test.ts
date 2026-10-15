import { describe, expect, it } from 'vitest';
import { firstFormat, formatMemoKey, formatOf, isFormatMemo } from '../src/streamFormat.ts';

describe('stream format memory', () => {
  it('reads the format from the URL', () => {
    expect(formatOf('http://example.test/live/u/p/1.m3u8')).toBe('m3u8');
    expect(formatOf('http://example.test/live/u/p/1.m3u8?token=1')).toBe('m3u8');
    expect(formatOf('http://example.test/live/u/p/1.ts')).toBe('ts');
    expect(formatOf('http://example.test/u/p/1')).toBe('ts');
  });

  it('tries the format that played last, unless the setting changed since', () => {
    expect(firstFormat('ts', undefined)).toBe('ts');
    expect(firstFormat('ts', { format: 'm3u8', pref: 'ts' })).toBe('m3u8');
    expect(firstFormat('m3u8', { format: 'ts', pref: 'ts' })).toBe('m3u8');
    expect(firstFormat('m3u8', { format: 'ts', pref: 'm3u8' })).toBe('ts');
  });

  it('validates stored memos', () => {
    expect(isFormatMemo({ format: 'ts', pref: 'm3u8' })).toBe(true);
    for (const v of [null, undefined, 'ts', { format: 'mp4', pref: 'ts' }, { format: 'ts' }]) expect(isFormatMemo(v)).toBe(false);
  });

  it('keys the memo by the opaque source id only', () => {
    expect(formatMemoKey('src1')).toBe('streamFormat:src1');
  });
});
