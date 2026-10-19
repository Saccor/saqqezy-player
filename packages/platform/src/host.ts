export type PlatformId = 'browser' | 'desktop' | 'tizen' | 'webos' | 'androidtv';
export type HostEngine = 'mpv' | 'media3';
export type NetKind = 'raw' | 'media' | 'image';

/**
 * Injected by a native shell as `globalThis.__IPTV_HOST__` before the app bundle runs (Tauri init script, Android
 * `evaluateJavascript` before load). Spec 2026-10-19-beta-foundations §1.1.
 */
export interface HostInfo {
  kind: 'desktop' | 'androidtv';
  protocol: number;
  shellVersion: string;
  engine?: HostEngine;
  net?: { base: string; kinds: readonly NetKind[] };
  exit?(): void;
  saveFile?(name: string, text: string): Promise<boolean>;
  /** Coarse device facts for Diagnostics and low-RAM limits; primitives with token-like keys and strings only. */
  device?: Readonly<Record<string, string | number | boolean>>;
}

const KINDS = ['desktop', 'androidtv'];
const TOKEN = /^[A-Za-z0-9 ._+-]{1,40}$/;

function safeDevice(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!TOKEN.test(k)) continue;
    if (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && TOKEN.test(x))) out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}
const ENGINES = ['mpv', 'media3'];
const NET_KINDS: readonly NetKind[] = ['raw', 'media', 'image'];

/** A validated copy of an injected host object; undefined when absent or malformed. */
export function readHostInfo(g: unknown): HostInfo | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const o = g as Record<string, unknown>;
  if (typeof o.kind !== 'string' || KINDS.indexOf(o.kind) < 0) return undefined;
  if (typeof o.protocol !== 'number' || !Number.isFinite(o.protocol)) return undefined;
  if (typeof o.shellVersion !== 'string') return undefined;
  const out: HostInfo = { kind: o.kind as HostInfo['kind'], protocol: o.protocol, shellVersion: o.shellVersion };
  if (typeof o.engine === 'string' && ENGINES.indexOf(o.engine) >= 0) out.engine = o.engine as HostEngine;
  const net = o.net as { base?: unknown; kinds?: unknown } | undefined;
  if (net && typeof net.base === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(net.base) && Array.isArray(net.kinds)) {
    out.net = { base: net.base, kinds: NET_KINDS.filter((k) => (net.kinds as unknown[]).indexOf(k) >= 0) };
  }
  if (typeof o.exit === 'function') out.exit = o.exit as () => void;
  if (typeof o.saveFile === 'function') out.saveFile = o.saveFile as HostInfo['saveFile'];
  const device = safeDevice(o.device);
  if (device) out.device = device;
  return out;
}

export function detectPlatform(ua: string, globals: { tizen?: unknown; webOS?: unknown; __IPTV_HOST__?: unknown }): PlatformId {
  const host = readHostInfo(globals.__IPTV_HOST__);
  if (host) return host.kind;
  if (globals.tizen !== undefined || /tizen/i.test(ua)) return 'tizen';
  if (globals.webOS !== undefined || /web0s|webos/i.test(ua)) return 'webos';
  return 'browser';
}
