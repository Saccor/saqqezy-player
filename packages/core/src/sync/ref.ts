import type { SourceConfig } from '../types.ts';
import { normalizeServer } from '../xtream/client.ts';

/**
 * A portable reference to one piece of user state (§6.2). Stored ids differ per device (`sourceId` is random), so a
 * record names its source by fingerprint and its item by the id without the `sourceId:` prefix.
 */
export interface SyncRef {
  /** Source fingerprint: `HMAC-SHA256(K_fp, canonical identity)`, truncated (`sourceFingerprint`). */
  sfp: string;
  /** Stored id without the `sourceId:` prefix (`toSid`); group ids, which carry none, as they are. */
  sid: string;
  /** Portable key when the id alone may differ between sources of one account: VOD title group key, series key + S/E, live fold key. */
  pk?: string;
}

/** 16 bytes (128 bits) as unpadded base64url. */
export const SFP_LENGTH = 22;
const SFP_BYTES = 16;
const FP_INFO = 'iptv-sync/v1/fp';

/**
 * What makes two sources "the same account" on two devices, computed on the device only (never sent, not even
 * encrypted: only its HMAC leaves). Xtream: lower-cased `host:port` (default port filled in) and the user name; the
 * password is never part of it. M3U: the playlist URL with scheme and host lower-cased, the default port and the
 * fragment dropped, path and query kept as they are.
 */
export function canonicalSourceIdentity(source: SourceConfig): string {
  if (source.kind === 'xtream') {
    const base = normalizeServer(source.server);
    let hostPort = base.replace(/^https?:\/\//i, '').toLowerCase();
    try {
      const u = new URL(base);
      hostPort = `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
    } catch {
      // Not a URL: the trimmed, lower-cased text stands in.
    }
    return `xtream\n${hostPort}\n${source.username.trim()}`;
  }
  const raw = source.playlistUrl.trim();
  try {
    const u = new URL(raw);
    u.hash = '';
    // URL lower-cases scheme and host and drops a default port.
    return `m3u\n${u.toString()}`;
  } catch {
    return `m3u\n${raw}`;
  }
}

/**
 * `K_fp` from the 256-bit sync key `SK`: HKDF-SHA256 (empty salt, info `iptv-sync/v1/fp`) to a non-extractable
 * HMAC-SHA256 key. HKDF and HMAC are on the Chromium 76 floor. The other keys of §6.4 use their own info labels.
 */
export async function deriveFingerprintKey(sk: Uint8Array): Promise<CryptoKey> {
  if (sk.length !== 32) throw new Error('The sync key must be 32 bytes.');
  const base = await crypto.subtle.importKey('raw', sk, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(FP_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The source's fingerprint (`SyncRef.sfp`): the HMAC of its canonical identity, truncated to 128 bits. */
export async function sourceFingerprint(kFp: CryptoKey, source: SourceConfig): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', kFp, new TextEncoder().encode(canonicalSourceIdentity(source)));
  return base64url(new Uint8Array(mac).subarray(0, SFP_BYTES));
}

/** `SyncRef.sid` of a stored id: without the `sourceId:` prefix when it has one (group ids have none). */
export function toSid(sourceId: string, localId: string): string {
  const prefix = `${sourceId}:`;
  return localId.startsWith(prefix) ? localId.slice(prefix.length) : localId;
}

/** The stored id of a source-scoped `sid` (channels, VOD items) on this device. Group ids are used as they are. */
export const fromSid = (sourceId: string, sid: string): string => `${sourceId}:${sid}`;
