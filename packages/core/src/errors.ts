export class SourceAuthError extends Error {
  constructor(message = 'The provider rejected the login. Check your details.') {
    super(message);
    this.name = 'SourceAuthError';
  }
}

export class SourceNetworkError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SourceNetworkError';
  }
}

export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  for (const key of ['username', 'password']) {
    if (u.searchParams.has(key)) u.searchParams.set(key, '***');
  }
  const parts = u.pathname.split('/');
  // Xtream stream paths: /live|movie|series/{user}/{pass}/{id}.{ext}, and /timeshift/{user}/{pass}/{min}/{start}/{id}.{ext}
  if (parts.length >= 5 && ['live', 'movie', 'series', 'timeshift'].includes(parts[1] ?? '')) {
    parts[2] = '***';
    parts[3] = '***';
  } else if (parts.length === 4 && parts[1] && parts[2] && /^\d+(?:\.(?:ts|m3u8))?$/.test(parts[3] ?? '')) {
    // Xtream short form: /{user}/{pass}/{id}, optionally with a .ts or .m3u8 extension
    parts[1] = '***';
    parts[2] = '***';
  }
  const path = parts.join('/');
  const query = u.searchParams.toString().replace(/%2A/g, '*'); // not replaceAll: Chromium 85+ only
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
}

/** What the app says while a source is in its refusal cooldown (neutral: no provider, no "ban"). */
export const SOURCE_REFUSING_MESSAGE = "Your source is refusing connections. The app is waiting so you don't get blocked.";

/** What the app says while a source is blocked because it stopped answering (the unreachable breaker). */
export const SOURCE_UNREACHABLE_MESSAGE = "Your source isn't answering. The app is waiting so it doesn't flood it.";

/** Which cooldown blocks a source: it refused us, or it did not answer at all. */
export type SourceBlockReason = 'refused' | 'unreachable';

/**
 * Thrown instead of sending a request while the source is in a cooldown. Nothing reached the source. The name is the
 * same for both reasons (callers and the UI treat both as "blocked"); the message says which.
 */
export class SourceRefusedError extends Error {
  constructor(readonly reason: SourceBlockReason = 'refused') {
    super(reason === 'unreachable' ? SOURCE_UNREACHABLE_MESSAGE : SOURCE_REFUSING_MESSAGE);
    this.name = 'SourceRefused';
  }
}

/** What the app says when a downloaded list cannot be saved because the device is full (neutral: no provider). */
export const storageFullMessage = (what: 'movie' | 'series'): string => `Not enough storage on this TV to save the ${what} list`;
/** What the app says when saving failed for another reason (a closing or refusing database). */
export const storageFailedMessage = (what: 'movie' | 'series'): string => `Could not save the ${what} list on this TV`;

/** Whether a write failed because the device is full: a `QuotaExceededError`, a DOMException with code 22, or the form `idbStorage` produces. */
export function isQuotaError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const c = cause as { name?: unknown; code?: unknown; message?: unknown };
  return c.name === 'QuotaExceededError' || c.code === 22 || c.message === 'IndexedDB QuotaExceededError';
}

/** The name of an error (for the log), or '' when it has none. */
export const causeName = (cause: unknown): string =>
  typeof cause === 'object' && cause !== null && typeof (cause as { name?: unknown }).name === 'string' ? (cause as { name: string }).name : '';

/**
 * Thrown when saving something that was fetched fine failed on the device (a full or refusing database). The name and
 * message reach the error log; `cause` keeps the original error and `quota` says whether it was a full device.
 * `value` is what could not be saved, so a caller can keep using it for the session.
 */
export class StorageWriteError<V = unknown> extends Error {
  readonly quota: boolean;
  constructor(readonly store: string, override readonly cause: unknown, message = `Could not save ${store}`, readonly value?: V) {
    super(message);
    this.quota = isQuotaError(cause);
    this.name = 'StorageWriteError';
  }
}
