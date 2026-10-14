import type { NewSource, SourceConfig } from '@iptv/core';

/**
 * Copies only the fields the protocol defines for the source's kind. The TV's validator rejects unknown
 * fields, so a source received from a (possibly newer) TV is cleaned before it is sent back in `updateSource`.
 */
export function cleanSource(s: SourceConfig): SourceConfig {
  if (s.kind === 'xtream') {
    return { kind: 'xtream', id: s.id, name: s.name, server: s.server, username: s.username, password: s.password };
  }
  const out: SourceConfig = { kind: 'm3u', id: s.id, name: s.name, playlistUrl: s.playlistUrl };
  if (typeof s.epgUrl === 'string') out.epgUrl = s.epgUrl;
  return out;
}

/** The Add/Edit form's fields. Lives in memory only while the form is open (it can hold credentials). */
export interface SourceForm {
  kind: 'xtream' | 'm3u';
  name: string;
  server: string;
  username: string;
  password: string;
  playlistUrl: string;
  epgUrl: string;
}

export function emptyForm(kind: SourceForm['kind']): SourceForm {
  return { kind, name: '', server: '', username: '', password: '', playlistUrl: '', epgUrl: '' };
}

export function formFromSource(s: SourceConfig): SourceForm {
  const f = emptyForm(s.kind);
  f.name = s.name;
  if (s.kind === 'xtream') {
    f.server = s.server;
    f.username = s.username;
    f.password = s.password;
  } else {
    f.playlistUrl = s.playlistUrl;
    f.epgUrl = s.epgUrl ?? '';
  }
  return f;
}

/**
 * The form as a NewSource: only the chosen kind's fields; everything trimmed except the password (kept exactly
 * as typed, like the TV form). The TV validates and defaults the name.
 */
export function formToInput(f: SourceForm): NewSource {
  const name = f.name.trim();
  if (f.kind === 'xtream') {
    return { kind: 'xtream', name, server: f.server.trim(), username: f.username.trim(), password: f.password };
  }
  const input: NewSource = { kind: 'm3u', name, playlistUrl: f.playlistUrl.trim() };
  const epg = f.epgUrl.trim();
  if (epg) input.epgUrl = epg;
  return input;
}

export function formToSource(f: SourceForm, id: string): SourceConfig {
  return { ...formToInput(f), id } as SourceConfig;
}
