import { describe, expect, it } from 'vitest';
import { isPhoneToTv, MAX_FIELD_LEN } from '@iptv/companion-protocol';
import { HEADER_VALUE_MAX, NAME_MAX } from '@iptv/core';
import {
  cleanSource, emptyForm, FORM_LIMITS, formFromSource, formProblem, formToInput, formToSource, HEADER_UNUSED_NOTE, headerDimmed,
  headerHelp, headersAllowed, readTvHeaders,
} from './source.ts';

describe('cleanSource', () => {
  it('keeps only the known Xtream fields', () => {
    const received = {
      kind: 'xtream', id: 's1', name: 'Home', server: 'http://tv.example.test', username: 'u', password: 'p',
      extra: 'from a newer TV', nested: { a: 1 },
    };
    expect(cleanSource(received as never)).toEqual({
      kind: 'xtream', id: 's1', name: 'Home', server: 'http://tv.example.test', username: 'u', password: 'p',
    });
  });

  it('keeps only the known M3U fields, and epgUrl only when present', () => {
    const withEpg = { kind: 'm3u', id: 's2', name: 'List', playlistUrl: 'http://pl.example.test/a.m3u', epgUrl: 'http://g.example.test/e.xml', x: 1 };
    expect(cleanSource(withEpg as never)).toEqual({
      kind: 'm3u', id: 's2', name: 'List', playlistUrl: 'http://pl.example.test/a.m3u', epgUrl: 'http://g.example.test/e.xml',
    });
    const without = { kind: 'm3u', id: 's2', name: 'List', playlistUrl: 'http://pl.example.test/a.m3u', y: 2 };
    expect(cleanSource(without as never)).toEqual({ kind: 'm3u', id: 's2', name: 'List', playlistUrl: 'http://pl.example.test/a.m3u' });
  });

  it('produces an updateSource the strict TV validator accepts', () => {
    const received = { kind: 'xtream', id: 's1', name: 'Home', server: 'http://tv.example.test', username: 'u', password: 'p', extra: true };
    expect(isPhoneToTv({ t: 'updateSource', source: received })).toBe(false);
    expect(isPhoneToTv({ t: 'updateSource', source: cleanSource(received as never) })).toBe(true);
  });
});

describe('source form', () => {
  it('builds an Xtream NewSource, dropping M3U fields', () => {
    const f = { ...emptyForm('xtream'), name: 'Home', server: 'http://tv.example.test:8080', username: 'user', password: 'pass', playlistUrl: 'x' };
    expect(formToInput(f)).toEqual({ kind: 'xtream', name: 'Home', server: 'http://tv.example.test:8080', username: 'user', password: 'pass' });
    expect(isPhoneToTv({ t: 'addSource', input: formToInput(f) })).toBe(true);
  });

  it('builds an M3U NewSource, with the guide URL only when filled in', () => {
    const f = { ...emptyForm('m3u'), name: 'List', playlistUrl: 'http://pl.example.test/a.m3u', epgUrl: '  ' };
    expect(formToInput(f)).toEqual({ kind: 'm3u', name: 'List', playlistUrl: 'http://pl.example.test/a.m3u' });
    const g = { ...f, epgUrl: 'http://g.example.test/e.xml' };
    expect(formToInput(g)).toEqual({ kind: 'm3u', name: 'List', playlistUrl: 'http://pl.example.test/a.m3u', epgUrl: 'http://g.example.test/e.xml' });
  });

  it('keeps the password exactly as typed, trims the rest', () => {
    const f = { ...emptyForm('xtream'), name: ' Home ', server: ' http://tv.example.test ', username: ' user ', password: ' p w ' };
    expect(formToInput(f)).toEqual({ kind: 'xtream', name: 'Home', server: 'http://tv.example.test', username: 'user', password: ' p w ' });
  });

  it('round-trips an existing source through the form for editing', () => {
    const src = { kind: 'xtream' as const, id: 's1', name: 'Home', server: 'http://tv.example.test', username: 'u', password: 'p' };
    const f = formFromSource(src);
    expect(f.kind).toBe('xtream');
    expect(formToSource(f, 's1')).toEqual(src);
    expect(isPhoneToTv({ t: 'updateSource', source: formToSource(f, 's1') })).toBe(true);
  });
});

describe('form limits and checks (parity with the TV)', () => {
  it('the name limit is NAME_MAX, the URL / credential limit the protocol MAX_FIELD_LEN, headers the stored cap', () => {
    expect(FORM_LIMITS).toEqual({ name: NAME_MAX, url: MAX_FIELD_LEN, credential: MAX_FIELD_LEN, header: HEADER_VALUE_MAX });
  });

  it('the password is required as typed: spaces count, like the TV form', () => {
    const f = { ...emptyForm('xtream'), server: 'http://tv.example.test', username: 'u' };
    expect(formProblem({ ...f, password: '' })).toBe('Enter the server address, username and password.');
    expect(formProblem({ ...f, password: ' ' })).toBeUndefined();
    expect(formProblem({ ...f, username: '  ', password: 'p' })).toBe('Enter the server address, username and password.');
    expect(formProblem({ ...emptyForm('m3u'), playlistUrl: '  ' })).toBe('Enter the playlist URL.');
  });

  it('a name over NAME_MAX (after trimming) is caught before sending', () => {
    const f = { ...emptyForm('m3u'), playlistUrl: 'http://pl.example.test/a.m3u' };
    expect(formProblem({ ...f, name: 'n'.repeat(NAME_MAX + 1) })).toBe(`Use a name of ${NAME_MAX} characters or fewer.`);
    expect(formProblem({ ...f, name: ` ${'n'.repeat(NAME_MAX)} ` })).toBeUndefined();
  });

  it('every form that passes the checks with http(s) addresses makes a message the strict TV validator accepts', () => {
    const forms = [
      { ...emptyForm('xtream'), server: 'http://tv.example.test:8080', username: ' u ', password: ' ' },
      { ...emptyForm('xtream'), name: 'n'.repeat(NAME_MAX), server: 'https://tv.example.test', username: 'u', password: 'p w' },
      { ...emptyForm('m3u'), playlistUrl: 'http://pl.example.test/a.m3u', epgUrl: ' ' },
      { ...emptyForm('m3u'), name: ` ${'n'.repeat(NAME_MAX)} `, playlistUrl: 'http://pl.example.test/a.m3u', epgUrl: 'http://g.example.test/e.xml' },
    ];
    for (const f of forms) {
      expect(formProblem(f)).toBeUndefined();
      expect(isPhoneToTv({ t: 'addSource', input: formToInput(f) })).toBe(true);
      expect(isPhoneToTv({ t: 'updateSource', source: formToSource(f, 's1') })).toBe(true);
    }
  });
});

describe('source User-Agent and Referer (protocol 2, spec 2026-10-20-source-headers §6.3)', () => {
  const xt = { kind: 'xtream', id: 's1', name: 'Home', server: 'http://tv.example.test', username: 'u', password: 'p' } as const;

  it('the gate: only a TV on protocol 2 or newer gets the fields', () => {
    expect(headersAllowed(undefined)).toBe(false);
    expect(headersAllowed(1)).toBe(false);
    expect(headersAllowed(2)).toBe(true);
  });

  it('cleanSource keeps the fields only for a v2 TV', () => {
    const received = { ...xt, userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' };
    expect(cleanSource(received)).toEqual(xt);
    expect(cleanSource(received, true)).toEqual(received);
  });

  it('the form round-trips the fields', () => {
    const f = formFromSource({ ...xt, userAgent: 'SyntheticAgent/1.0' });
    expect(f.userAgent).toBe('SyntheticAgent/1.0');
    expect(f.referrer).toBe('');
    expect(emptyForm('m3u')).toMatchObject({ userAgent: '', referrer: '' });
  });

  it('a v1 TV gets nothing new, whatever the form holds', () => {
    const f = { ...formFromSource(xt), userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' };
    const input = formToInput(f);
    const source = formToSource(f, 's1');
    expect('userAgent' in input || 'referrer' in input).toBe(false);
    expect('userAgent' in source || 'referrer' in source).toBe(false);
    expect(isPhoneToTv({ t: 'updateSource', source })).toBe(true);
  });

  it('a v2 TV: add sends non-empty values; an edit sends both, "" meaning clear', () => {
    const f = { ...formFromSource(xt), userAgent: ' SyntheticAgent/1.0 ', referrer: '  ' };
    expect(formToInput(f, true)).toEqual({ kind: 'xtream', name: 'Home', server: 'http://tv.example.test', username: 'u', password: 'p', userAgent: 'SyntheticAgent/1.0' });
    const source = formToSource(f, 's1', true);
    expect(source).toMatchObject({ userAgent: 'SyntheticAgent/1.0', referrer: '' });
    expect(isPhoneToTv({ t: 'updateSource', source })).toBe(true);
  });

  it('help text and dimmed fields follow the TV header support; no presets or names', () => {
    const T = { userAgent: true, referrer: true };
    const F = { userAgent: false, referrer: false };
    const tizen = { lists: F, streams: { userAgent: true, referrer: false } };
    expect(headerHelp({ lists: T, streams: T })).toBe("Sent with this source's lists, guide and streams. Leave empty to use the app's default.");
    expect(headerHelp(tizen)).toBe("On your TV only the User-Agent is sent, and only with streams. Lists and the guide use the TV's own.");
    expect(headerHelp({ lists: F, streams: F })).toBe('Your TV cannot send these headers. The values are kept but not used there.');
    expect(headerHelp(undefined)).toBe("Sent by your TV where it can. Leave empty to use the app's default.");
    expect(headerDimmed(tizen, 'referrer')).toBe(true);
    expect(headerDimmed(tizen, 'userAgent')).toBe(false);
    expect(headerDimmed(undefined, 'referrer')).toBe(false);
    expect(HEADER_UNUSED_NOTE).toBe('Not used on your TV');
    for (const t of [headerHelp(tizen), headerHelp(undefined), HEADER_UNUSED_NOTE]) {
      expect(t).not.toMatch(/Mozilla|Chrome|Safari|VLC|Kodi|Samsung|IPTV|provider/i);
    }
  });
});

describe('readTvHeaders', () => {
  it('keeps a well-formed welcome.tv.headers, drops anything else', () => {
    const ok = { lists: { userAgent: false, referrer: false }, streams: { userAgent: true, referrer: false } };
    expect(readTvHeaders(ok)).toEqual(ok);
    expect(readTvHeaders(undefined)).toBeUndefined();
    expect(readTvHeaders({ lists: ok.lists })).toBeUndefined();
    expect(readTvHeaders({ lists: { userAgent: 'yes', referrer: false }, streams: ok.streams })).toBeUndefined();
  });
});
