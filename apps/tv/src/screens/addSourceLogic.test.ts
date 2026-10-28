import { describe, expect, it } from 'vitest';
import { MAX_FIELD_LEN } from '@iptv/companion-protocol';
import { HEADER_VALUE_MAX, NAME_MAX } from '@iptv/core';
import {
  HEADER_FIELD_MAX, HEADER_UNUSED_NOTE, advancedHelp, connectionsLine, headerFieldDimmed, httpFormFromSource, withHttpSettings,
  DEFAULT_NAME, FIELD_MAX, GENERIC_ERROR, NAME_TOO_LONG, SOURCE_NAME_MAX, URL_MAX, afterAdd, clampField, backFromTypeStep, errorMessage, formFromSource, isHttpUrl, maskSecret, progressText,
  revealLabel, toUpdatedSource, validateM3u, validateXtream,
} from './addSourceLogic.ts';

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe('isHttpUrl', () => {
  it('accepts http and https URLs only', () => {
    expect(isHttpUrl('http://127.0.0.1:8899')).toBe(true);
    expect(isHttpUrl('https://example.test/get.php?a=1')).toBe(true);
    expect(isHttpUrl('example.test')).toBe(false);
    expect(isHttpUrl('ftp://example.test')).toBe(false);
    expect(isHttpUrl('http://')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('validateXtream', () => {
  const ok = { name: '', server: ' http://example.test:8080 ', username: ' user ', password: ' p w ' };

  it('builds the input, trimming everything but the password and defaulting the name', () => {
    expect(validateXtream(ok)).toEqual({
      ok: true,
      input: { kind: 'xtream', name: DEFAULT_NAME, server: 'http://example.test:8080', username: 'user', password: ' p w ' },
    });
    expect(validateXtream({ ...ok, name: ' Living room ' })).toMatchObject({ ok: true, input: { name: 'Living room' } });
  });

  it('reports the first missing or invalid field', () => {
    expect(validateXtream({ ...ok, server: ' ' })).toEqual({ ok: false, field: 'server', message: 'Enter the server address.' });
    expect(validateXtream({ ...ok, server: 'example.test' }))
      .toEqual({ ok: false, field: 'server', message: 'Enter a server address starting with http:// or https://.' });
    expect(validateXtream({ ...ok, username: '' })).toEqual({ ok: false, field: 'username', message: 'Enter your username.' });
    expect(validateXtream({ ...ok, password: '' })).toEqual({ ok: false, field: 'password', message: 'Enter your password.' });
  });

  it('never puts the password into a validation message', () => {
    const r = validateXtream({ ...ok, server: 'nope', password: 'secret-value' });
    expect(JSON.stringify(r)).not.toContain('secret-value');
  });
});

describe('validateM3u', () => {
  const ok = { name: '', playlistUrl: 'http://example.test/list.m3u', epgUrl: '' };

  it('builds the input and omits an empty guide URL', () => {
    expect(validateM3u(ok)).toEqual({ ok: true, input: { kind: 'm3u', name: DEFAULT_NAME, playlistUrl: 'http://example.test/list.m3u' } });
    expect(validateM3u({ ...ok, epgUrl: ' http://example.test/epg.xml ' }))
      .toMatchObject({ ok: true, input: { epgUrl: 'http://example.test/epg.xml' } });
  });

  it('requires a valid playlist URL and a valid guide URL when given', () => {
    expect(validateM3u({ ...ok, playlistUrl: '' })).toEqual({ ok: false, field: 'playlistUrl', message: 'Enter the M3U link.' });
    expect(validateM3u({ ...ok, playlistUrl: 'list.m3u' }))
      .toEqual({ ok: false, field: 'playlistUrl', message: 'Enter a link starting with http:// or https://.' });
    expect(validateM3u({ ...ok, epgUrl: 'guide' }))
      .toEqual({ ok: false, field: 'epgUrl', message: 'Enter a guide link (http:// or https://) or leave it empty.' });
  });
});

describe('errorMessage', () => {
  it('shows the message of auth and network errors', () => {
    expect(errorMessage(named('SourceAuthError', 'The provider account has expired.'))).toBe('The provider account has expired.');
    expect(errorMessage(named('SourceNetworkError', 'Could not reach the provider.'))).toBe('Could not reach the provider.');
  });

  it('falls back to the generic text for anything else', () => {
    expect(errorMessage(named('RpcError', 'Unknown method'))).toBe(GENERIC_ERROR);
    expect(errorMessage(new TypeError('x'))).toBe(GENERIC_ERROR);
    expect(errorMessage('boom')).toBe(GENERIC_ERROR);
    expect(errorMessage(named('SourceAuthError', ''))).toBe(GENERIC_ERROR);
    expect(GENERIC_ERROR).toBe('Something went wrong. Please try again.');
  });
});

describe('progressText', () => {
  it('reads "Connecting…" before progress and formats counts with grouping', () => {
    expect(progressText(undefined)).toBe('Connecting…');
    expect(progressText({ phase: 'playlist', count: 12400 })).toBe('Loading channels… 12,400');
    expect(progressText({ phase: 'epg', count: 3000 })).toBe('Loading TV guide… 3,000');
  });
});

describe('maskSecret', () => {
  it('masks every character, counting whole characters', () => {
    expect(maskSecret('test')).toBe('••••');
    expect(maskSecret('')).toBe('');
    expect(maskSecret('å😀')).toBe('••');
  });
});

describe('backFromTypeStep', () => {
  it('lets Back bubble on the root screen without sources (the shell asks to exit)', () => {
    expect(backFromTypeStep({ hasSources: false, depth: 1 })).toBe('bubble');
  });
  it('blocks Back without sources when something is underneath', () => {
    expect(backFromTypeStep({ hasSources: false, depth: 2 })).toBe('stay');
  });
  it('returns to the screen underneath (Settings) when sources exist', () => {
    expect(backFromTypeStep({ hasSources: true, depth: 2 })).toBe('bubble');
  });
  it('opens Settings when sources exist but Add source is the root', () => {
    expect(backFromTypeStep({ hasSources: true, depth: 1 })).toBe('settings');
  });
});

describe('edit mode', () => {
  it('prefills the form of the source kind', () => {
    expect(formFromSource({ kind: 'xtream', id: 's1', name: 'A', server: 'http://example.test', username: 'u', password: 'p' }))
      .toEqual({ kind: 'xtream', xtream: { name: 'A', server: 'http://example.test', username: 'u', password: 'p' } });
    expect(formFromSource({ kind: 'm3u', id: 's2', name: 'B', playlistUrl: 'http://example.test/a.m3u' }))
      .toEqual({ kind: 'm3u', m3u: { name: 'B', playlistUrl: 'http://example.test/a.m3u', epgUrl: '' } });
  });
  it('keeps the id when saving the validated form', () => {
    const v = validateM3u({ name: ' B ', playlistUrl: 'http://example.test/a.m3u', epgUrl: '' });
    if (!v.ok) throw new Error('invalid');
    expect(toUpdatedSource('s2', v.input)).toEqual({ kind: 'm3u', id: 's2', name: 'B', playlistUrl: 'http://example.test/a.m3u' });
  });
});

describe('edit keeps the Advanced settings', () => {
  const stored = {
    kind: 'xtream' as const, id: 's1', name: 'A', server: 'http://example.test', username: 'u', password: 'p',
    userAgent: 'TestAgent/1.0', referrer: 'http://example.test/', maxConnections: 2,
  };
  it('carries the stored User-Agent and Referer through an edit of the login form', () => {
    const v = validateXtream({ name: 'B', server: 'http://example.test', username: 'u2', password: 'p' });
    if (!v.ok) throw new Error('invalid');
    expect(toUpdatedSource('s1', v.input, stored)).toEqual({
      kind: 'xtream', id: 's1', name: 'B', server: 'http://example.test', username: 'u2', password: 'p',
      userAgent: 'TestAgent/1.0', referrer: 'http://example.test/',
    });
  });
  it('adds nothing when the stored source has no settings', () => {
    const v = validateM3u({ name: 'B', playlistUrl: 'http://example.test/a.m3u', epgUrl: '' });
    if (!v.ok) throw new Error('invalid');
    expect(toUpdatedSource('s2', v.input, { kind: 'm3u', id: 's2', name: 'A', playlistUrl: 'http://example.test/a.m3u' }))
      .toEqual({ kind: 'm3u', id: 's2', name: 'B', playlistUrl: 'http://example.test/a.m3u' });
  });
});

describe('Advanced (User-Agent and Referer)', () => {
  const m3u = { kind: 'm3u' as const, id: 's2', name: 'B', playlistUrl: 'http://example.test/a.m3u' };
  it('prefills from the source; empty when unset', () => {
    expect(httpFormFromSource(m3u)).toEqual({ userAgent: '', referrer: '' });
    expect(httpFormFromSource({ ...m3u, userAgent: 'TestAgent/1.0', referrer: 'http://example.test/' }))
      .toEqual({ userAgent: 'TestAgent/1.0', referrer: 'http://example.test/' });
  });
  it('saves trimmed values on the stored source; empty means the default (the field is removed)', () => {
    expect(withHttpSettings(m3u, { userAgent: '  TestAgent/2.0 ', referrer: '' }))
      .toEqual({ ...m3u, userAgent: 'TestAgent/2.0' });
    expect(withHttpSettings({ ...m3u, userAgent: 'Old', referrer: 'http://example.test/' }, { userAgent: ' ', referrer: '' }))
      .toEqual(m3u);
  });
  it('the field limit matches the stored cap', () => {
    expect(HEADER_FIELD_MAX).toBe(HEADER_VALUE_MAX);
  });
});

describe('Advanced help and dimmed fields per platform (spec 2026-10-20-source-headers §6.1)', () => {
  const T = { userAgent: true, referrer: true };
  const F = { userAgent: false, referrer: false };
  const all = { lists: T, streams: T };
  const tizen = { lists: F, streams: { userAgent: true, referrer: false } };
  const webos = { lists: F, streams: F };

  it('says what is sent on this device, in plain words', () => {
    expect(advancedHelp(all)).toBe('Sent with lists, guide and streams. Empty uses the default.');
    expect(advancedHelp(tizen)).toBe('Used for streams only.');
    expect(advancedHelp(webos)).toBe('Not used on this TV.');
    expect(advancedHelp({ lists: T, streams: F })).toBe('Used for lists and the guide only.');
  });

  it('dims a field the platform cannot use (still editable); the note is neutral', () => {
    expect(headerFieldDimmed(all, 'userAgent')).toBe(false);
    expect(headerFieldDimmed(tizen, 'userAgent')).toBe(false);
    expect(headerFieldDimmed(tizen, 'referrer')).toBe(true);
    expect(headerFieldDimmed(webos, 'userAgent')).toBe(true);
    expect(HEADER_UNUSED_NOTE).toBe('Not used on this TV');
  });

  it('no presets and no app, device or provider names in the copy', () => {
    const texts = [all, tizen, webos, { lists: T, streams: F }].map(advancedHelp).concat(HEADER_UNUSED_NOTE);
    for (const t of texts) expect(t).not.toMatch(/Mozilla|Chrome|Safari|VLC|Kodi|Samsung|LG|Smart|IPTV|provider|try /i);
  });
});

describe('connectionsLine', () => {
  it('shows the account limit when known', () => {
    expect(connectionsLine(2)).toBe('Connections allowed: 2');
    expect(connectionsLine(1)).toBe('Connections allowed: 1');
    expect(connectionsLine(undefined)).toBeUndefined();
    expect(connectionsLine(0)).toBeUndefined();
  });
});

describe('afterAdd', () => {
  it('first run (Add source is the root): Home replaces it', () => {
    expect(afterAdd({ depth: 1, becameActive: true })).toBe('replaceHome');
  });
  it('from Settings, a source that is not active: back to Settings, so it can be set active there', () => {
    expect(afterAdd({ depth: 3, becameActive: false })).toBe('back');
  });
  it('from Settings, a source that became active (no other sources): a fresh Home', () => {
    expect(afterAdd({ depth: 3, becameActive: true })).toBe('resetHome');
  });
});

describe('field limits (shared with the companion protocol)', () => {
  it('the name and URL limits are the core NAME_MAX and the protocol MAX_FIELD_LEN', () => {
    expect(SOURCE_NAME_MAX).toBe(NAME_MAX);
    expect(URL_MAX).toBe(MAX_FIELD_LEN);
    expect(FIELD_MAX).toEqual({
      name: NAME_MAX, server: MAX_FIELD_LEN, username: MAX_FIELD_LEN, password: MAX_FIELD_LEN,
      playlistUrl: MAX_FIELD_LEN, epgUrl: MAX_FIELD_LEN,
    });
  });

  it('clampField cuts at the limit without splitting a surrogate pair', () => {
    expect(clampField('abcdef', 4)).toBe('abcd');
    expect(clampField('abc', 4)).toBe('abc');
    expect(clampField('ab\u{1F600}', 3)).toBe('ab');
    expect(clampField('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
  });

  it('validation rejects a name over the limit (after trimming), in both forms', () => {
    const long = 'n'.repeat(SOURCE_NAME_MAX + 1);
    expect(validateXtream({ name: long, server: 'http://example.test', username: 'u', password: 'p' }))
      .toEqual({ ok: false, field: 'name', message: NAME_TOO_LONG });
    expect(validateM3u({ name: long, playlistUrl: 'http://example.test/a.m3u', epgUrl: '' }))
      .toEqual({ ok: false, field: 'name', message: NAME_TOO_LONG });
    const exact = ` ${'n'.repeat(SOURCE_NAME_MAX)} `;
    expect(validateM3u({ name: exact, playlistUrl: 'http://example.test/a.m3u', epgUrl: '' }).ok).toBe(true);
  });
});

describe('revealLabel (pointer button next to the password)', () => {
  it('uses the spec copy', () => {
    expect(revealLabel(false)).toBe('Show password');
    expect(revealLabel(true)).toBe('Hide password');
  });
});
