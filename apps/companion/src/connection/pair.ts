import { normalizeCode, secretsFromCode, secretsFromQrFragment, type PairingSecrets } from '@iptv/companion-protocol';

/** The `location` fields pairing reads. */
export interface LocationLike {
  hash: string;
  pathname: string;
  search: string;
}

/**
 * Reads the QR pairing fragment (`#s=…&k=…`) and strips any fragment from the address bar at once, so the
 * secrets never stay in the URL, the history entry or a bookmark. Returns the fragment when it has non-empty
 * `s` and `k`, otherwise null. Never logs it.
 */
export function takePairingFragment(loc: LocationLike, replace: (url: string) => void): string | null {
  const hash = loc.hash;
  if (!hash || hash === '#') return null;
  replace(loc.pathname + loc.search);
  const params = new URLSearchParams(hash.slice(1));
  return params.get('s') && params.get('k') ? hash : null;
}

/** Strips the fragment from the real address bar and returns it (see `takePairingFragment`). */
export function takeFragmentFromWindow(): string | null {
  return takePairingFragment(window.location, (url) => history.replaceState(null, '', url));
}

/** Pairing code input formatting while typing: A–Z and 0–9 only, uppercase, at most 12, grouped as XXXX-XXXX-XXXX. */
export function formatCodeInput(raw: string): string {
  const chars = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  return chars.replace(/(.{4})(?=.)/g, '$1-');
}

/** True when the input is a full, valid pairing code (Crockford base32, after normalisation). */
export function isCodeComplete(input: string): boolean {
  return normalizeCode(input) !== null;
}

/** QR mode: the secrets are in the fragment; no key derivation needed. */
export function pairFromFragment(fragment: string): Promise<PairingSecrets> {
  return secretsFromQrFragment(fragment);
}

/** Code mode: one PBKDF2 derivation (≈ 0.2–1 s). Throws on an invalid code. */
export async function pairFromCode(input: string): Promise<PairingSecrets> {
  const code = normalizeCode(input);
  if (!code) throw new Error('invalid code');
  return secretsFromCode(code);
}

export interface ClientInfo {
  kind: 'phone' | 'desktop';
  label: string;
}

/**
 * The label the TV shows for this companion ("Connected to iPhone"), from the user-agent. `maxTouchPoints`
 * tells iPadOS (which reports itself as a Mac) apart from a real Mac. Tablets count as `phone` (handheld).
 */
export function detectClient(ua: string, maxTouchPoints = 0): ClientInfo {
  if (/iPhone|iPod/.test(ua)) return { kind: 'phone', label: 'iPhone' };
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return { kind: 'phone', label: 'iPad' };
  if (/Android/.test(ua)) {
    return /Mobile/.test(ua) ? { kind: 'phone', label: 'Android phone' } : { kind: 'phone', label: 'Android tablet' };
  }
  if (/Windows/.test(ua)) return { kind: 'desktop', label: 'Windows PC' };
  if (/Macintosh|Mac OS X/.test(ua)) return { kind: 'desktop', label: 'Mac' };
  if (/CrOS/.test(ua)) return { kind: 'desktop', label: 'Chromebook' };
  if (/Linux|X11/.test(ua)) return { kind: 'desktop', label: 'Linux PC' };
  return { kind: 'desktop', label: 'Web browser' };
}
