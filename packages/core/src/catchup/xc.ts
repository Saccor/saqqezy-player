/** Xtream timeshift URLs (spec 2026-10-20-catch-up §1.4), for Xtream sources and M3U `xc` channels. */
import { zeroPad as pad } from '../text/pad.ts';
import { wallClock, type CatchupZone } from './zone.ts';

/** The pieces of an Xtream live URL; `user` and `pass` decoded. */
export interface XcParts { server: string; user: string; pass: string; streamId: string; ext: 'ts' | 'm3u8' }

const LONG = /^(.*)\/live\/([^/]+)\/([^/]+)\/(\d+)\.(ts|m3u8)$/;
const SHORT = /^\/([^/]+)\/([^/]+)\/(\d+)(?:\.(ts|m3u8))?$/;

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** `{server}/live/{user}/{pass}/{id}.{ext}` or `{server}/{user}/{pass}/{id}` (TS); anything else is undefined. */
export function parseXcLiveUrl(url: string): XcParts | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const origin = `${u.protocol}//${u.host}`;
  const long = LONG.exec(u.pathname);
  if (long) return { server: origin + long[1]!, user: dec(long[2]!), pass: dec(long[3]!), streamId: long[4]!, ext: long[5] as 'ts' | 'm3u8' };
  const short = SHORT.exec(u.pathname);
  if (short && !/^(live|movie|series|timeshift)$/.test(short[1]!)) {
    return { server: origin, user: dec(short[1]!), pass: dec(short[2]!), streamId: short[3]!, ext: (short[4] ?? 'ts') as 'ts' | 'm3u8' };
  }
  return undefined;
}


/** `YYYY-MM-DD:HH-MM` of `ms` in `zone`, floored to the minute. */
export function xcStart(ms: number, zone: CatchupZone): string {
  const w = wallClock(Math.floor(ms / 60_000) * 60_000, zone);
  return `${pad(w.Y, 4)}-${pad(w.m)}-${pad(w.d)}:${pad(w.H)}-${pad(w.M)}`;
}

/** Minutes to ask for: the programme rounded up, plus one for the minute floor of the start. */
export const xcDurationMin = (start: number, stop: number): number => Math.max(1, Math.ceil((stop - start) / 60_000)) + 1;

/** `{server}/timeshift/{user}/{pass}/{durationMin}/{YYYY-MM-DD:HH-MM}/{streamId}.{ext}`. */
export function xcTimeshiftUrl(p: XcParts, start: number, stop: number, zone: CatchupZone): string {
  const e = encodeURIComponent;
  return `${p.server}/timeshift/${e(p.user)}/${e(p.pass)}/${xcDurationMin(start, stop)}/${xcStart(start, zone)}/${p.streamId}.${p.ext}`;
}

/** `{server}/streaming/timeshift.php?username=…&password=…&stream=…&start=…&duration=…` (the alternate). */
export function xcTimeshiftPhpUrl(p: XcParts, start: number, stop: number, zone: CatchupZone): string {
  const q = new URLSearchParams({
    username: p.user, password: p.pass, stream: p.streamId, start: xcStart(start, zone), duration: String(xcDurationMin(start, stop)),
  });
  return `${p.server}/streaming/timeshift.php?${q.toString()}`;
}
