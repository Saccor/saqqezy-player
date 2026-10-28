/**
 * Catch-up (archive) for the fake provider, on with `catchup: true`: synthetic channels with `tv_archive`, the Xtream
 * `timeshift` routes, `get_simple_data_table`, a panel clock in `PANEL_ZONE`, and an M3U playlist with every
 * `catchup` mode. Every archive request that is inside its window redirects to the same licensed test stream as live.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { slots, TEST_STREAM, type FakeChannel } from './data.ts';
import { showcaseProgramme } from './showcase.ts';

/** The panel's zone (`server_info.timezone`): one with DST, so the archive window crosses a change. */
const PANEL_ZONE = 'Europe/Stockholm';
const SLOT = 30 * 60_000;
const DAY = 86_400_000;

/** Archive days of channel `n`: 7 for n % 4 = 1, 3 for n % 4 = 2, none otherwise. */
export const archiveDays = (n: number): number => (n % 4 === 1 ? 7 : n % 4 === 2 ? 3 : 0);

/** `ms` as `YYYY-MM-DD HH:MM:SS` wall-clock time in `zone`. */
export function wallClockIn(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}:${p('second')}`;
}

/** Wall-clock `YYYY-MM-DD:HH-MM` or `YYYY-MM-DD HH:MM[:SS]` in `zone` back to UTC ms; undefined when unreadable. */
export function parseWallClock(text: string, zone: string): number | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d)[: ](\d\d)[-:](\d\d)(?::(\d\d))?$/.exec(text);
  if (!m) return undefined;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  // The zone's offset at a guess, then again at the corrected instant (right on both sides of a DST change).
  const offsetAt = (ms: number) => {
    const w = wallClockIn(ms, zone);
    return Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13), +w.slice(14, 16), +w.slice(17, 19)) - ms;
  };
  let utc = asUtc - offsetAt(asUtc);
  utc = asUtc - offsetAt(utc);
  return utc;
}

/** Half-hour slots before `slots(now)` back to `days` ago: what a 7-day archive channel's guide adds. */
function historySlots(now: number, days: number): { start: number; stop: number; k: number }[] {
  const end = slots(now)[0]!.start;
  const out = [];
  for (let t = Math.ceil((now - days * DAY) / SLOT) * SLOT, k = 1; t < end; t += SLOT, k++) out.push({ start: t, stop: t + SLOT, k });
  return out;
}

/** The extra XMLTV programmes of a channel with a 7-day archive (other channels keep the usual 6 h of history). */
export function xmltvHistory(c: FakeChannel, now: number, xmlDate: (ms: number) => string, showcase = false): string {
  if (archiveDays(c.n) !== 7) return '';
  let buf = '';
  for (const s of historySlots(now, 7)) {
    const p = showcase ? showcaseProgramme(Number(c.categoryId) - 1, s.k, c.n) : { title: `Archive programme ${s.k}`, desc: `Synthetic archived listing for ${c.name}.` };
    buf += `<programme start="${xmlDate(s.start)}" stop="${xmlDate(s.stop)}" channel="${c.epgId}"><title>${p.title.replace(/&/g, '&amp;')}</title><desc>${p.desc.replace(/&/g, '&amp;')}</desc></programme>\n`;
  }
  return buf;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** `get_simple_data_table` for channel `c`: its archive days (or 6 h) of history to 24 h ahead, with `has_archive`. */
export function simpleDataTable(c: FakeChannel | undefined, now: number, showcase = false): unknown {
  if (!c) return { epg_listings: [] };
  const days = archiveDays(c.n);
  const named = (k: number, plain: string) => (showcase ? showcaseProgramme(Number(c.categoryId) - 1, k, c.n).title : plain);
  const rows = [
    ...(days ? historySlots(now, days).map((s) => ({ ...s, title: named(s.k, `Archive programme ${s.k}`) })) : []),
    ...slots(now).map((s) => ({ ...s, title: named(s.index, `Programme ${s.index}`) })),
  ];
  return {
    epg_listings: rows.map((s, i) => ({
      id: String(c.n * 100_000 + i), epg_id: c.epgId, title: b64(s.title), lang: 'en',
      start: wallClockIn(s.start, PANEL_ZONE), end: wallClockIn(s.stop, PANEL_ZONE),
      description: b64(`Synthetic listing for ${c.name}.`), channel_id: c.epgId,
      start_timestamp: String(s.start / 1000), stop_timestamp: String(s.stop / 1000),
      now_playing: s.start <= now && now < s.stop ? 1 : 0,
      has_archive: days > 0 && s.stop <= now && s.start >= now - days * DAY ? 1 : 0,
    })),
  };
}

/** `server_info` with the panel zone and clock. */
export function serverInfo(base: string, now: number): Record<string, unknown> {
  return {
    url: base, timezone: PANEL_ZONE, timestamp_now: Math.floor(now / 1000), time_now: wallClockIn(now, PANEL_ZONE),
  };
}

/** `get_live_streams` extra fields for channel `n`. */
export function archiveFields(n: number): { tv_archive: number; tv_archive_duration: string } {
  const days = archiveDays(n);
  return { tv_archive: days ? 1 : 0, tv_archive_duration: String(days) };
}

/** A start inside `days` (one minute of slack for the minute floor) and not in the future. */
const inWindow = (start: number | undefined, now: number, days: number) =>
  start !== undefined && Number.isFinite(start) && start <= now && start >= now - days * DAY - 60_000;

/**
 * The playlist `/catchup.m3u` (every entry its own URL, so none is merged as a duplicate): one entry per mode on synthetic channels whose guide has history (tvg-id of fake
 * channels 1, 2, 5 and 9), an archive that always answers 404, and a template the app cannot read.
 */
function catchupM3u(base: string, user: string, pass: string): string {
  const live = `${base}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}`;
  const e = (attrs: string, name: string, url: string) => [`#EXTINF:-1 ${attrs} group-title="Catch-up",${name}`, url];
  return [
    '#EXTM3U catchup-days="2"',
    ...e(`tvg-id="c1.test" catchup="default" catchup-days="7" catchup-source="${base}/archive/1/index.m3u8?start={utc}&end={utcend}"`,
      'Catch-up default', `${base}/plain/1.m3u8`),
    ...e(`tvg-id="c1.test" catchup="default" catchup-days="7" catchup-correction="0" catchup-source="${base}/archive/1/{Y}-{m}-{d}/{H}-{M}.m3u8?minutes={duration:60}"`,
      'Catch-up wall clock', `${base}/plain/1.m3u8?v=wall`),
    ...e(`tvg-id="c5.test" catchup="append" catchup-days="7" catchup-source="?utc={utc}&lutc={lutc}"`,
      'Catch-up append', `${base}/plain/5.m3u8?token=synthetic`),
    ...e('tvg-id="c9.test" catchup="shift"', 'Catch-up shift', `${base}/plain/9.m3u8`),
    ...e('tvg-id="c9.test" catchup="flussonic" catchup-days="7"', 'Catch-up flussonic', `${base}/flu/ch9/index.m3u8`),
    ...e('tvg-id="c1.test" catchup="xc" catchup-days="7"', 'Catch-up xc', `${live}/1.ts`),
    ...e('tvg-id="c2.test"', 'Catch-up inferred', `${base}/plain/2.m3u8`),
    ...e(`tvg-id="c5.test" catchup="default" catchup-days="7" catchup-source="${base}/archive/gone/index.m3u8?start={utc}&end={utcend}"`,
      'Catch-up not available', `${base}/plain/5.m3u8?v=gone`),
    ...e(`tvg-id="c1.test" catchup="default" catchup-days="7" catchup-source="${base}/archive/1/index.m3u8?start={unknown}"`,
      'Catch-up unsupported', `${base}/plain/1.m3u8?v=unsupported`),
  ].join('\n') + '\n';
}

/**
 * Archive and plain-stream routes (live redirects too). Returns true when it answered. `valid(user, pass)` is the
 * fake login; `streamStatus(user)` the special users' stream answers (404, 403, 429).
 */
export function handleCatchup(
  req: IncomingMessage, res: ServerResponse, url: URL, base: string, chs: FakeChannel[], now: number,
  valid: (user: string, pass: string) => boolean,
  streamStatus: (user: string) => { status: number; headers?: Record<string, string> } | undefined,
): boolean {
  void req;
  const go = (ok: boolean) => {
    if (ok) res.writeHead(302, { location: TEST_STREAM });
    else res.writeHead(404, { 'content-type': 'text/plain' });
    res.end();
    return true;
  };
  const p = url.pathname;
  const q = url.searchParams;
  const secs = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? Number(v) * 1000 : undefined);

  if (p === '/catchup.m3u') {
    const user = q.get('username') ?? '';
    const pass = q.get('password') ?? '';
    if (!valid(user, pass)) {
      res.writeHead(401);
      res.end();
      return true;
    }
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
    res.end(catchupM3u(base, user, pass));
    return true;
  }

  // Xtream timeshift: path form and php form.
  let ts: { user: string; pass: string; start: string; stream: number } | undefined;
  const path = /^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/([^/]+)\/(\d+)\.([a-z0-9]+)$/.exec(p);
  if (path) ts = { user: decodeURIComponent(path[1]!), pass: decodeURIComponent(path[2]!), start: decodeURIComponent(path[4]!), stream: Number(path[5]) };
  if (p === '/streaming/timeshift.php') {
    ts = { user: q.get('username') ?? '', pass: q.get('password') ?? '', start: q.get('start') ?? '', stream: Number(q.get('stream')) };
  }
  if (ts) {
    if (!valid(ts.user, ts.pass)) {
      res.writeHead(401);
      res.end();
      return true;
    }
    const answer = streamStatus(ts.user);
    if (answer) {
      res.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers });
      res.end();
      return true;
    }
    const c = chs.find((x) => x.n === ts.stream);
    const days = c ? archiveDays(c.n) : 0;
    return go(days > 0 && inWindow(parseWallClock(ts.start, PANEL_ZONE), now, days));
  }

  // M3U playlist streams: plain live (shift and append add `utc` to them), absolute archive templates, Flussonic.
  if (/^\/plain\/\d+\.m3u8$/.test(p)) {
    const utc = q.get('utc');
    return go(utc === null || inWindow(secs(utc), now, 7));
  }
  const archive = /^\/archive\/(\d+|gone)\/index\.m3u8$/.exec(p);
  if (archive) return go(archive[1] !== 'gone' && inWindow(secs(q.get('start')), now, 7));
  const wall = /^\/archive\/\d+\/(\d{4}-\d\d-\d\d)\/(\d\d)-(\d\d)\.m3u8$/.exec(p);
  if (wall) return go(inWindow(parseWallClock(`${wall[1]}:${wall[2]}-${wall[3]}`, 'UTC'), now, 7));
  if (/^\/flu\/ch\d+\/((index|video|mono)\.m3u8|mpegts)$/.test(p)) return go(true);
  const flu = /^\/flu\/ch\d+\/(?:(?:index|video|mono)-(\d+)-(\d+)\.m3u8|timeshift_abs-(\d+)\.ts)$/.exec(p);
  if (flu) return go(inWindow(secs(flu[1] ?? flu[3]), now, 7));
  return false;
}
