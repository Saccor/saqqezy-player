import { NAME_MAX } from '../layout/types.ts';
import type { NewSource } from './sourceService.ts';

/**
 * The words of a rejected source input. The phone companion gets `SOURCE_INPUT_TEXT`; the TV form passes its own
 * copy, which says the same.
 */
export interface SourceInputText {
  /** The name a source gets when the field is left empty. */
  defaultName: string;
  nameTooLong: (max: number) => string;
  enterServer: string;
  serverUrl: string;
  enterUsername: string;
  enterPassword: string;
  enterLink: string;
  linkUrl: string;
  guideUrl: string;
}

export const SOURCE_INPUT_TEXT: SourceInputText = {
  defaultName: 'My TV',
  nameTooLong: (max) => `Use a name of ${max} characters or fewer.`,
  enterServer: 'Enter the server address.',
  serverUrl: 'Enter a server address starting with http:// or https://.',
  enterUsername: 'Enter your username.',
  enterPassword: 'Enter your password.',
  enterLink: 'Enter the M3U link.',
  linkUrl: 'Enter a link starting with http:// or https://.',
  guideUrl: 'Enter a guide link (http:// or https://) or leave it empty.',
};

export type SourceInputField = 'name' | 'server' | 'username' | 'password' | 'playlistUrl' | 'epgUrl';

export type SourceInputCheck =
  | { ok: true; input: NewSource }
  | { ok: false; field: SourceInputField; message: string };

/** An absolute http:// or https:// URL with a host. */
export function isHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
}

/**
 * The one rule set for a new source, from the TV's Add source form and from the phone companion (a security
 * boundary: keep it strict): names of at most NAME_MAX characters (after trimming), http/https addresses only,
 * required fields present, an empty name defaulted, the password kept exactly as typed and everything else trimmed.
 * The result is a fresh object with only the source's fields. Messages never echo the input.
 */
export function validateSourceInput(input: NewSource, text: SourceInputText = SOURCE_INPUT_TEXT): SourceInputCheck {
  if (input.name.trim().length > NAME_MAX) return { ok: false, field: 'name', message: text.nameTooLong(NAME_MAX) };
  const name = input.name.trim() || text.defaultName;
  if (input.kind === 'xtream') {
    const server = input.server.trim();
    const username = input.username.trim();
    if (!server) return { ok: false, field: 'server', message: text.enterServer };
    if (!isHttpUrl(server)) return { ok: false, field: 'server', message: text.serverUrl };
    if (!username) return { ok: false, field: 'username', message: text.enterUsername };
    if (!input.password) return { ok: false, field: 'password', message: text.enterPassword };
    return { ok: true, input: { kind: 'xtream', name, server, username, password: input.password } };
  }
  const playlistUrl = input.playlistUrl.trim();
  const epgUrl = (input.epgUrl ?? '').trim();
  if (!playlistUrl) return { ok: false, field: 'playlistUrl', message: text.enterLink };
  if (!isHttpUrl(playlistUrl)) return { ok: false, field: 'playlistUrl', message: text.linkUrl };
  if (epgUrl && !isHttpUrl(epgUrl)) return { ok: false, field: 'epgUrl', message: text.guideUrl };
  const out: NewSource = { kind: 'm3u', name, playlistUrl };
  if (epgUrl) out.epgUrl = epgUrl;
  return { ok: true, input: out };
}
