import { MAX_FIELD_LEN } from '@iptv/companion-protocol';
import { NAME_MAX, type NewSource, type SourceConfig } from '@iptv/core';

/** Input limits of the Add/Edit form: the same contract as the TV form and the protocol validator. */
export const FORM_LIMITS = { name: NAME_MAX, url: MAX_FIELD_LEN, credential: MAX_FIELD_LEN } as const;

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

/**
 * What is missing or wrong before sending (undefined: fine to send), with the TV form's rules: required fields
 * trimmed except the password (kept as typed, so spaces count), and a name of at most NAME_MAX characters.
 * The TV checks addresses itself; `CompanionClient.request` also runs the protocol validator before sending.
 */
export function formProblem(f: SourceForm): string | undefined {
  if (f.name.trim().length > FORM_LIMITS.name) return `Use a name of ${FORM_LIMITS.name} characters or fewer.`;
  const required = f.kind === 'xtream'
    ? f.server.trim() !== '' && f.username.trim() !== '' && f.password !== ''
    : f.playlistUrl.trim() !== '';
  if (!required) return f.kind === 'xtream' ? 'Enter the server address, username and password.' : 'Enter the playlist URL.';
  return undefined;
}
