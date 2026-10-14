/** Pure helpers for the Add source screen (validation, error copy, progress copy). Unit-tested. */
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { NewSource, SourceConfig } from '@iptv/core';

export const DEFAULT_NAME = 'My TV';

/**
 * Field limits, shared with the phone companion's contract: the name limit is `NAME_MAX` in @iptv/core, the others
 * the companion protocol's `MAX_FIELD_LEN`. Copied as numbers because neither package may enter the main-thread
 * bundle; addSourceLogic.test.ts checks that they agree.
 */
export const SOURCE_NAME_MAX = 60;
export const URL_MAX = 8192;
export const FIELD_MAX: Readonly<Record<string, number>> = {
  name: SOURCE_NAME_MAX, server: URL_MAX, username: URL_MAX, password: URL_MAX, playlistUrl: URL_MAX, epgUrl: URL_MAX,
};
export const NAME_TOO_LONG = `Use a name of ${SOURCE_NAME_MAX} characters or fewer.`;

/** Cuts `v` to at most `max` UTF-16 units (the protocol's measure) without splitting a surrogate pair. */
export function clampField(v: string, max: number): string {
  if (v.length <= max) return v;
  const code = v.charCodeAt(max - 1);
  return v.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export interface XtreamForm { name: string; server: string; username: string; password: string }
export interface M3uForm { name: string; playlistUrl: string; epgUrl: string }

export type Validation<F> =
  | { ok: true; input: NewSource }
  | { ok: false; field: keyof F & string; message: string };

export function isHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
}

const nameOf = (name: string) => name.trim() || DEFAULT_NAME;
const nameTooLong = (name: string) => name.trim().length > SOURCE_NAME_MAX;

/** The password is kept exactly as typed (it may legitimately contain spaces); everything else is trimmed. */
export function validateXtream(f: XtreamForm): Validation<XtreamForm> {
  if (nameTooLong(f.name)) return { ok: false, field: 'name', message: NAME_TOO_LONG };
  const server = f.server.trim();
  const username = f.username.trim();
  if (!server) return { ok: false, field: 'server', message: 'Enter the server address.' };
  if (!isHttpUrl(server)) {
    return { ok: false, field: 'server', message: 'Enter a server address starting with http:// or https://.' };
  }
  if (!username) return { ok: false, field: 'username', message: 'Enter your username.' };
  if (!f.password) return { ok: false, field: 'password', message: 'Enter your password.' };
  return { ok: true, input: { kind: 'xtream', name: nameOf(f.name), server, username, password: f.password } };
}

export function validateM3u(f: M3uForm): Validation<M3uForm> {
  if (nameTooLong(f.name)) return { ok: false, field: 'name', message: NAME_TOO_LONG };
  const playlistUrl = f.playlistUrl.trim();
  const epgUrl = f.epgUrl.trim();
  if (!playlistUrl) return { ok: false, field: 'playlistUrl', message: 'Enter the playlist URL.' };
  if (!isHttpUrl(playlistUrl)) {
    return { ok: false, field: 'playlistUrl', message: 'Enter a playlist URL starting with http:// or https://.' };
  }
  if (epgUrl && !isHttpUrl(epgUrl)) {
    return { ok: false, field: 'epgUrl', message: 'Enter a TV guide URL starting with http:// or https://, or leave it empty.' };
  }
  const input: NewSource = { kind: 'm3u', name: nameOf(f.name), playlistUrl };
  if (epgUrl) input.epgUrl = epgUrl;
  return { ok: true, input };
}

/**
 * Inline error copy. Core's auth and network errors carry neutral, credential-free messages (the worker
 * scrubs URLs); anything else gets the generic text so internals never reach the screen.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && (err.name === 'SourceAuthError' || err.name === 'SourceNetworkError') && err.message) {
    return err.message;
  }
  return GENERIC_ERROR;
}

export function progressText(p: { phase: 'playlist' | 'epg'; count: number } | undefined): string {
  if (!p) return 'Connecting…';
  const n = p.count.toLocaleString('en-US');
  return p.phase === 'playlist' ? `Loading channels… ${n}` : `Loading TV guide… ${n}`;
}

export function maskSecret(s: string): string {
  return '•'.repeat(Array.from(s).length);
}

/**
 * Back on step 1. Leaving is only possible when other sources exist: then Back returns to the screen
 * underneath (Settings), or opens Settings when Add source is the root. Without sources, the root screen
 * lets Back reach the shell (exit question); otherwise it stays.
 */
export function backFromTypeStep(s: { hasSources: boolean; depth: number }): 'bubble' | 'settings' | 'stay' {
  if (s.hasSources) return s.depth > 1 ? 'bubble' : 'settings';
  return s.depth > 1 ? 'stay' : 'bubble';
}

/**
 * Where a successful add goes. As the root (first run) Home replaces Add source. Opened from Settings it returns
 * there (the new source is listed and can be set active), unless the new source became the active one, which
 * starts a fresh Home instead of leaving two Homes on the stack.
 */
export function afterAdd(s: { depth: number; becameActive: boolean }): 'replaceHome' | 'resetHome' | 'back' {
  if (s.depth <= 1) return 'replaceHome';
  return s.becameActive ? 'resetHome' : 'back';
}

export type SourceForm = { kind: 'xtream'; xtream: XtreamForm } | { kind: 'm3u'; m3u: M3uForm };

/** Edit mode: the form of the source's kind, prefilled from the stored source. */
export function formFromSource(src: SourceConfig): SourceForm {
  if (src.kind === 'xtream') {
    return { kind: 'xtream', xtream: { name: src.name, server: src.server, username: src.username, password: src.password } };
  }
  return { kind: 'm3u', m3u: { name: src.name, playlistUrl: src.playlistUrl, epgUrl: src.epgUrl ?? '' } };
}

/** Edit mode: the validated form as the stored source (same id), for `api.updateSource`. */
export function toUpdatedSource(id: string, input: NewSource): SourceConfig {
  return { ...input, id } as SourceConfig;
}
