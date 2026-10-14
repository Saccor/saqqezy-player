import { describe, expect, it } from 'vitest';
import type { NewSource } from '@iptv/core';
import { validateSourceInput } from '@iptv/app-api';
import { validateM3u, validateXtream, type M3uForm, type XtreamForm } from './addSourceLogic.ts';

/**
 * The phone companion's source input goes through app-api's `validateSourceInput`, the on-TV form through
 * `validateXtream` / `validateM3u`. The two copies must agree on every input.
 */

const xtream: XtreamForm[] = [
  { name: '', server: 'http://example.test:8080', username: 'user', password: 'pass' },
  { name: ' Living room ', server: ' https://example.test ', username: ' user ', password: ' p w ' },
  { name: '', server: '', username: 'user', password: 'pass' },
  { name: '', server: '   ', username: 'user', password: 'pass' },
  { name: '', server: 'example.test:8080', username: 'user', password: 'pass' },
  { name: '', server: 'ftp://example.test', username: 'user', password: 'pass' },
  { name: '', server: 'http://', username: 'user', password: 'pass' },
  { name: '', server: 'javascript:alert(1)', username: 'user', password: 'pass' },
  { name: '', server: 'http://example.test', username: '   ', password: 'pass' },
  { name: '', server: 'http://example.test', username: 'user', password: '' },
  { name: '', server: 'http://example.test', username: 'user', password: ' ' },
  { name: 'A', server: 'HTTPS://EXAMPLE.TEST/path?x=1', username: 'u', password: 'p' },
];

const m3u: M3uForm[] = [
  { name: '', playlistUrl: 'http://media.example.test/list.m3u', epgUrl: '' },
  { name: ' Home ', playlistUrl: ' https://media.example.test/list.m3u ', epgUrl: ' https://media.example.test/epg.xml ' },
  { name: '', playlistUrl: '', epgUrl: '' },
  { name: '', playlistUrl: '  ', epgUrl: '' },
  { name: '', playlistUrl: 'media.example.test/list.m3u', epgUrl: '' },
  { name: '', playlistUrl: 'file:///etc/passwd', epgUrl: '' },
  { name: '', playlistUrl: 'http://media.example.test/list.m3u', epgUrl: 'ftp://media.example.test/epg.xml' },
  { name: '', playlistUrl: 'http://media.example.test/list.m3u', epgUrl: '   ' },
  { name: '', playlistUrl: 'http://media.example.test/list.m3u', epgUrl: 'not a url' },
];

type Outcome = { ok: true; input: NewSource } | { ok: false; message: string };

const tvOutcome = (v: ReturnType<typeof validateXtream> | ReturnType<typeof validateM3u>): Outcome =>
  v.ok ? { ok: true, input: v.input } : { ok: false, message: v.message };

describe('source validation parity (TV form vs companion input)', () => {
  it.each(xtream.map((f, i) => [i, f] as const))('xtream case %i agrees', (_i, f) => {
    expect(validateSourceInput({ kind: 'xtream', ...f })).toEqual(tvOutcome(validateXtream(f)));
  });

  it.each(m3u.map((f, i) => [i, f] as const))('m3u case %i agrees', (_i, f) => {
    expect(validateSourceInput({ kind: 'm3u', ...f })).toEqual(tvOutcome(validateM3u(f)));
  });

  it('m3u without an epgUrl field agrees with an empty form field', () => {
    const f: M3uForm = { name: 'x', playlistUrl: 'http://media.example.test/list.m3u', epgUrl: '' };
    expect(validateSourceInput({ kind: 'm3u', name: f.name, playlistUrl: f.playlistUrl })).toEqual(tvOutcome(validateM3u(f)));
  });
});
