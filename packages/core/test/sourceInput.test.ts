import { describe, expect, test } from 'vitest';
import { NAME_MAX, SOURCE_INPUT_TEXT, validateSourceInput, type SourceInputText } from '../src/index.ts';

describe('validateSourceInput', () => {
  test('names the field it rejects, in check order', () => {
    const x = { kind: 'xtream' as const, name: '', server: 'http://example.test', username: 'u', password: 'p' };
    expect(validateSourceInput({ ...x, name: 'n'.repeat(NAME_MAX + 1), server: '' }))
      .toEqual({ ok: false, field: 'name', message: SOURCE_INPUT_TEXT.nameTooLong(NAME_MAX) });
    expect(validateSourceInput({ ...x, server: 'example.test' })).toMatchObject({ ok: false, field: 'server' });
    expect(validateSourceInput({ ...x, username: ' ' })).toMatchObject({ ok: false, field: 'username' });
    expect(validateSourceInput({ ...x, password: '' })).toMatchObject({ ok: false, field: 'password' });
    const m = { kind: 'm3u' as const, name: '', playlistUrl: 'http://example.test/a.m3u' };
    expect(validateSourceInput({ ...m, playlistUrl: 'file:///a' })).toMatchObject({ ok: false, field: 'playlistUrl' });
    expect(validateSourceInput({ ...m, epgUrl: 'ftp://example.test/e.xml' })).toMatchObject({ ok: false, field: 'epgUrl' });
  });

  test('keeps only the source fields and uses the given words', () => {
    const text: SourceInputText = { ...SOURCE_INPUT_TEXT, defaultName: 'Named', enterLink: 'Link please' };
    const input = { kind: 'm3u' as const, name: ' ', playlistUrl: ' http://example.test/a.m3u ', userAgent: 'A/1' };
    expect(validateSourceInput(input, text))
      .toEqual({ ok: true, input: { kind: 'm3u', name: 'Named', playlistUrl: 'http://example.test/a.m3u' } });
    expect(validateSourceInput({ ...input, playlistUrl: '' }, text)).toEqual({ ok: false, field: 'playlistUrl', message: 'Link please' });
  });
});
