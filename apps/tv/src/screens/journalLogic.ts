import type { JournalEvent, ReconnectReason } from '@iptv/player';
import { stripUrls } from './settingsLogic.ts';

/**
 * Text for Diagnostics → Playback log. Neutral copy (CLAUDE.md rule 3); events never carry URLs, so neither do
 * these lines.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const join = (...parts: (string | false | undefined)[]) => parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

const REASON: Record<ReconnectReason, string> = {
  noBytes: 'no data', emptyBuffer: 'buffer empty', frozenVideo: 'picture frozen', backstop: 'no progress',
};
const CODE: Record<string, string> = {
  NETWORK: 'network', MEDIA: 'media', DECODE: 'decode', UNSUPPORTED: 'not supported',
  EOS: 'source ended the stream', AUTH: 'source refused', UNKNOWN: 'unknown',
};
const CAUSE: Record<string, string> = {
  ...CODE, ...REASON,
  startTimeout: 'no picture at start', drift: 'far behind live', goLive: 'go live', edgeSeekFailed: 'jump to live failed',
};
const PRESET = { low: 'Low', balanced: 'Balanced', stable: 'Stable' } as const;
const FAILED = {
  unavailable: 'Gave up: stream unavailable', unsupported: 'Gave up: format not supported', refused: 'Gave up: source refused',
  gone: 'Gave up: not on the source',
} as const;
const WINDOW_MS = 30 * 60_000;

/** `HH:MM:SS` local time today; `DD/MM HH:MM:SS` on other days. */
export function logTime(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? time : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

export function eventText(e: JournalEvent): string {
  switch (e.k) {
    case 'page':
      if (e.what === 'hidden') return 'App in background';
      if (e.what === 'visible') return 'App back in front';
      return e.nav === 'reload' ? 'Page reload' : 'App started';
    case 'play':
      return join('Play', (e.channel && stripUrls(e.channel)) || 'Channel', PRESET[e.preset]);
    case 'open':
      return join(`Connect (attempt ${e.attempt})`, e.urlIndex > 0 && 'other format');
    case 'playing':
      return join('Playing', e.engine, e.firstFrameMs !== undefined && `${secs(e.firstFrameMs)} to picture`);
    case 'stall':
      return e.phase === 'start'
        ? join('Stall', e.bufferAheadS !== undefined && `${e.bufferAheadS.toFixed(1)} s buffered`)
        : join('Stall over', secs(e.durationMs));
    case 'ladder':
      if (e.action === 'gapJump') return 'Skipped a gap in the stream';
      if (e.action === 'seekLive') return 'Jumped to live';
      return join('Stream stuck', e.reason !== undefined && REASON[e.reason]);
    case 'error':
      return join('Error', CODE[e.code] ?? e.code, e.httpStatus !== undefined && `HTTP ${e.httpStatus}`, e.detail, e.engine);
    case 'reconnect':
      return join('Reconnect', CAUSE[e.cause] ?? e.cause, `${e.delayMs} ms`);
    case 'alternate':
      return 'Trying another stream format';
    case 'rateWait':
      return join('Waiting to connect', 'connection limit for this source', `${secs(e.delayMs)}`);
    case 'drift': {
      const where = [e.behindS !== undefined && `${Math.round(e.behindS)} s behind`, `target ${e.targetS.toFixed(1)} s`] as const;
      if (e.action === 'seek') return join('Caught up to live', ...where);
      if (e.action === 'reopen') return join('Restarted to catch up', ...where);
      return join(e.rate === undefined || e.rate === 1 ? 'Normal speed' : `Speed ${e.rate}×`, ...where);
    }
    case 'failed':
      return FAILED[e.reason];
    case 'giveUpRetry':
      return 'Retrying in the background';
    case 'stop':
      return 'Stopped';
  }
}

export function formatEvent(e: JournalEvent, now: number): { time: string; text: string } {
  return { time: logTime(e.t, now), text: eventText(e) };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Last 30 min: 2 stalls, 3 reconnects (no data ×2), 1 page reload", or "… no problems". */
export function journalSummary(entries: readonly JournalEvent[], now: number): string {
  let stalls = 0;
  let reloads = 0;
  const causes = new Map<string, number>();
  for (const e of entries) {
    if (e.t > now || now - e.t > WINDOW_MS) continue;
    if (e.k === 'stall' && e.phase === 'start') stalls++;
    else if (e.k === 'page' && e.what === 'load' && e.nav === 'reload') reloads++;
    else if (e.k === 'reconnect') causes.set(e.cause, (causes.get(e.cause) ?? 0) + 1);
  }
  let reconnects = 0;
  for (const n of causes.values()) reconnects += n;
  if (stalls + reconnects + reloads === 0) return 'Last 30 min: no problems';
  const parts: string[] = [];
  if (stalls > 0) parts.push(plural(stalls, 'stall'));
  if (reconnects > 0) {
    const [top, n] = [...causes.entries()].sort((a, b) => b[1] - a[1])[0]!;
    parts.push(`${plural(reconnects, 'reconnect')} (${CAUSE[top] ?? top} ×${n})`);
  }
  if (reloads > 0) parts.push(plural(reloads, 'page reload'));
  return `Last 30 min: ${parts.join(', ')}`;
}

/** One row per event, newest first; `id` is the event's index in `entries`. */
export function logRows(entries: readonly JournalEvent[], now: number): { id: string; time: string; text: string }[] {
  const rows: { id: string; time: string; text: string }[] = [];
  for (let i = entries.length - 1; i >= 0; i--) rows.push({ id: `e${i}`, ...formatEvent(entries[i]!, now) });
  return rows;
}

/** What "Copy log" puts on the clipboard: the summary, then one line per event, newest first. */
export function journalText(entries: readonly JournalEvent[], now: number): string {
  return [journalSummary(entries, now), ...logRows(entries, now).map((r) => `${r.time}  ${r.text}`)].join('\n');
}
