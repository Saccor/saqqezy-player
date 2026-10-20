import { HEADERS_PROTOCOL, MAX_FIELD_LEN, type TvHeaderSupport } from '@iptv/companion-protocol';
import { HEADER_VALUE_MAX, NAME_MAX, type NewSource, type SourceConfig } from '@iptv/core';

/** Input limits of the Add/Edit form: the same contract as the TV form and the protocol validator. */
export const FORM_LIMITS = { name: NAME_MAX, url: MAX_FIELD_LEN, credential: MAX_FIELD_LEN, header: HEADER_VALUE_MAX } as const;

/**
 * The version gate for the User-Agent and Referer fields: a TV older than protocol 2 rejects unknown fields, so
 * the form hides its Advanced section and nothing new is sent.
 */
export function headersAllowed(tvProtocol: number | undefined): boolean {
  return tvProtocol !== undefined && tvProtocol >= HEADERS_PROTOCOL;
}

/**
 * Copies only the fields the protocol defines for the source's kind (with `headers`, a v2 TV: also its User-Agent
 * and Referer). The TV's validator rejects unknown fields, so a source received from a (possibly newer) TV is
 * cleaned before it is sent back in `updateSource`.
 */
export function cleanSource(s: SourceConfig, headers = false): SourceConfig {
  let out: SourceConfig;
  if (s.kind === 'xtream') {
    out = { kind: 'xtream', id: s.id, name: s.name, server: s.server, username: s.username, password: s.password };
  } else {
    out = { kind: 'm3u', id: s.id, name: s.name, playlistUrl: s.playlistUrl };
    if (typeof s.epgUrl === 'string') out.epgUrl = s.epgUrl;
  }
  if (headers) {
    if (typeof s.userAgent === 'string') out.userAgent = s.userAgent;
    if (typeof s.referrer === 'string') out.referrer = s.referrer;
  }
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
  /** Advanced (v2 TVs only): free text, no presets; empty means the TV's default. */
  userAgent: string;
  referrer: string;
}

export function emptyForm(kind: SourceForm['kind']): SourceForm {
  return { kind, name: '', server: '', username: '', password: '', playlistUrl: '', epgUrl: '', userAgent: '', referrer: '' };
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
  f.userAgent = s.userAgent ?? '';
  f.referrer = s.referrer ?? '';
  return f;
}

/**
 * The form as a NewSource: only the chosen kind's fields; everything trimmed except the password (kept exactly
 * as typed, like the TV form). The TV validates and defaults the name. With `headers` (a v2 TV), a non-empty
 * User-Agent and Referer are added.
 */
export function formToInput(f: SourceForm, headers = false): NewSource {
  const name = f.name.trim();
  let input: NewSource;
  if (f.kind === 'xtream') {
    input = { kind: 'xtream', name, server: f.server.trim(), username: f.username.trim(), password: f.password };
  } else {
    input = { kind: 'm3u', name, playlistUrl: f.playlistUrl.trim() };
    const epg = f.epgUrl.trim();
    if (epg) input.epgUrl = epg;
  }
  if (headers) {
    const ua = f.userAgent.trim();
    const ref = f.referrer.trim();
    if (ua) input.userAgent = ua;
    if (ref) input.referrer = ref;
  }
  return input;
}

/**
 * The edit as a SourceConfig. With `headers` (a v2 TV) both fields are always sent: a value sets it and `""`
 * clears it on the TV (an absent field would keep the stored value, which only v1 phones rely on).
 */
export function formToSource(f: SourceForm, id: string, headers = false): SourceConfig {
  const out = { ...formToInput(f), id } as SourceConfig;
  if (headers) {
    out.userAgent = f.userAgent.trim();
    out.referrer = f.referrer.trim();
  }
  return out;
}

/** Advanced help: what the TV sends, from `welcome.tv.headers` (the TV's own rule, spec 2026-10-20-source-headers §6). */
export function headerHelp(support: TvHeaderSupport | undefined): string {
  if (!support) return "Sent by your TV where it can. Leave empty to use the app's default.";
  const { lists, streams } = support;
  if (lists.userAgent && lists.referrer && streams.userAgent && streams.referrer) {
    return "Sent with this source's lists, guide and streams. Leave empty to use the app's default.";
  }
  if (headerDimmed(support, 'userAgent') && headerDimmed(support, 'referrer')) {
    return 'Your TV cannot send these headers. The values are kept but not used there.';
  }
  if (!lists.userAgent && !lists.referrer && streams.userAgent && !streams.referrer) {
    return "On your TV only the User-Agent is sent, and only with streams. Lists and the guide use the TV's own.";
  }
  if (lists.userAgent && lists.referrer && !streams.userAgent && !streams.referrer) {
    return "On your TV these are sent with lists and the guide only. Leave empty to use the app's default.";
  }
  return "On your TV only some of these are sent. Leave empty to use the app's default.";
}

/** Under a field the TV cannot use: it stays editable (the value is kept). */
export const HEADER_UNUSED_NOTE = 'Not used on your TV';

/** True when the TV can send `field` with nothing; unknown support (no `headers` in welcome) dims nothing. */
export function headerDimmed(support: TvHeaderSupport | undefined, field: 'userAgent' | 'referrer'): boolean {
  return support !== undefined && !support.lists[field] && !support.streams[field];
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

/** `welcome.tv.headers` when well formed (the companion's validator is lenient); undefined otherwise. */
export function readTvHeaders(x: unknown): TvHeaderSupport | undefined {
  const flags = (v: unknown): v is { userAgent: boolean; referrer: boolean } =>
    typeof v === 'object' && v !== null
    && typeof (v as Record<string, unknown>).userAgent === 'boolean' && typeof (v as Record<string, unknown>).referrer === 'boolean';
  if (typeof x !== 'object' || x === null) return undefined;
  const { lists, streams } = x as Record<string, unknown>;
  if (!flags(lists) || !flags(streams)) return undefined;
  return { lists: { userAgent: lists.userAgent, referrer: lists.referrer }, streams: { userAgent: streams.userAgent, referrer: streams.referrer } };
}
