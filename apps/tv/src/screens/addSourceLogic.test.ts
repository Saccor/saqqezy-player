import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAME, GENERIC_ERROR, afterAdd, backFromTypeStep, errorMessage, formFromSource, isHttpUrl, maskSecret, progressText,
  toUpdatedSource, validateM3u, validateXtream,
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
    expect(validateM3u({ ...ok, playlistUrl: '' })).toEqual({ ok: false, field: 'playlistUrl', message: 'Enter the playlist URL.' });
    expect(validateM3u({ ...ok, playlistUrl: 'list.m3u' }))
      .toEqual({ ok: false, field: 'playlistUrl', message: 'Enter a playlist URL starting with http:// or https://.' });
    expect(validateM3u({ ...ok, epgUrl: 'guide' }))
      .toEqual({ ok: false, field: 'epgUrl', message: 'Enter a TV guide URL starting with http:// or https://, or leave it empty.' });
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
