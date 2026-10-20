/**
 * The catch-up zone (spec 2026-10-20-catch-up §4): the time zone wall-clock catch-up URLs (`xc`, `{Y}…`, `{utc:FMT}`)
 * are written in. Unix-second placeholders need none.
 */
export type CatchupZone = { kind: 'iana'; name: string } | { kind: 'fixed'; offsetMin: number };

/** Wall-clock fields, unpadded numbers (`m` is the month, `M` the minute). */
export interface WallClock { Y: number; m: number; d: number; H: number; M: number; S: number }

/** How the zone was chosen, for Diagnostics. */
export type ZoneHow = 'manual' | 'playlist' | 'iana' | 'fixed' | 'utc';
export interface ZoneChoice { zone: CatchupZone; how: ZoneHow }

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** A cached formatter for `name`, or null when the device's `Intl` does not know the zone. */
function formatter(name: string): Intl.DateTimeFormat | null {
  let f = formatters.get(name);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch {
      f = null;
    }
    formatters.set(name, f);
  }
  return f;
}

function utcFields(ms: number): WallClock {
  const d = new Date(ms);
  return {
    Y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(),
  };
}

/** `ms` as wall-clock time in `zone`. An IANA name the device cannot format reads as UTC (`pickZone` avoids that). */
export function wallClock(ms: number, zone: CatchupZone): WallClock {
  if (zone.kind === 'fixed') return utcFields(ms + zone.offsetMin * 60_000);
  const f = formatter(zone.name);
  if (!f) return utcFields(ms);
  const out: WallClock = { Y: 0, m: 0, d: 0, H: 0, M: 0, S: 0 };
  for (const p of f.formatToParts(new Date(ms))) {
    const n = Number(p.value);
    if (p.type === 'year') out.Y = n;
    else if (p.type === 'month') out.m = n;
    else if (p.type === 'day') out.d = n;
    else if (p.type === 'hour') out.H = n % 24;
    else if (p.type === 'minute') out.M = n;
    else if (p.type === 'second') out.S = n;
  }
  return out;
}

let zonesWorkCache: boolean | undefined;

/**
 * Startup feature check: noon UTC on 2026-07-01 and 2026-01-01 must format as 14 and 13 in Europe/Stockholm. A TV
 * whose `Intl` lacks zone data fails it, and IANA names are then never used.
 */
export function intlZonesWork(): boolean {
  if (zonesWorkCache === undefined) {
    const z: CatchupZone = { kind: 'iana', name: 'Europe/Stockholm' };
    zonesWorkCache = formatter(z.name) !== null
      && wallClock(Date.UTC(2026, 6, 1, 12), z).H === 14 && wallClock(Date.UTC(2026, 0, 1, 12), z).H === 13;
  }
  return zonesWorkCache;
}

export interface ZoneInputs {
  /** Settings → source → Advanced → Catch-up time (undefined = Auto). */
  userOffsetMin?: number;
  /** The channel's (or the playlist header's) `catchup-correction`, in minutes. */
  playlistCorrMin?: number;
  /** `server_info.timezone` from the last login (Xtream, or the M3U `xc` probe). */
  serverTimeZone?: string;
  /** Panel wall clock minus UTC in minutes from the last login. */
  serverOffsetMin?: number;
  /** Override the feature check (tests). */
  zonesWork?: boolean;
}

/** The catch-up zone in the order of spec §4: user, playlist, server IANA zone, server fixed offset, UTC. */
export function pickZone(i: ZoneInputs): ZoneChoice {
  if (i.userOffsetMin !== undefined) return { zone: { kind: 'fixed', offsetMin: i.userOffsetMin }, how: 'manual' };
  if (i.playlistCorrMin !== undefined) return { zone: { kind: 'fixed', offsetMin: i.playlistCorrMin }, how: 'playlist' };
  if (i.serverTimeZone && (i.zonesWork ?? intlZonesWork()) && formatter(i.serverTimeZone)) {
    return { zone: { kind: 'iana', name: i.serverTimeZone }, how: 'iana' };
  }
  if (i.serverOffsetMin !== undefined) return { zone: { kind: 'fixed', offsetMin: i.serverOffsetMin }, how: 'fixed' };
  return { zone: { kind: 'fixed', offsetMin: 0 }, how: 'utc' };
}

/** `+1:00`, `-3:30`. */
export function formatOffset(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

/** The Diagnostics wording: "Europe/Stockholm", "UTC+1:00 (fixed offset)", "UTC", "manual +1:00". */
export function zoneLabel(c: ZoneChoice): string {
  const off = c.zone.kind === 'fixed' ? c.zone.offsetMin : 0;
  if (c.zone.kind === 'iana') return c.zone.name;
  if (c.how === 'manual') return `manual ${formatOffset(off)}`;
  if (c.how === 'playlist') return `playlist ${formatOffset(off)}`;
  if (c.how === 'fixed') return `UTC${formatOffset(off)} (fixed offset)`;
  return 'UTC';
}

/**
 * Panel wall clock minus UTC in minutes, rounded to 15 min, from `server_info.time_now` (`YYYY-MM-DD HH:MM:SS`, panel
 * time) and `timestamp_now` (Unix seconds); undefined when either is missing or unreadable.
 */
export function serverOffsetFrom(timeNow: unknown, timestampNow: unknown): number | undefined {
  const ts = typeof timestampNow === 'number' ? timestampNow : typeof timestampNow === 'string' ? Number(timestampNow) : NaN;
  if (!Number.isFinite(ts) || ts <= 0 || typeof timeNow !== 'string') return undefined;
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(timeNow.trim());
  if (!m) return undefined;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  const min = Math.round((wall - ts * 1000) / 60_000 / 15) * 15;
  return min >= -12 * 60 && min <= 14 * 60 ? min : undefined;
}
