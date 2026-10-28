import { zeroPad as pad } from '@iptv/core';
import type { JournalEvent, ReconnectReason } from '@iptv/player';
import { SETTINGS_COPY } from '../copy.ts';
import { stripUrls } from './settingsLogic.ts';

/**
 * Text for Diagnostics → Playback log. Neutral copy (CLAUDE.md rule 3); events never carry URLs, so neither do
 * these lines.
 */

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const join = (...parts: (string | false | undefined)[]) => parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

const J = SETTINGS_COPY.journal;
const REASON: Record<ReconnectReason, string> = J.reason;
const CODE: Record<string, string> = J.code;
const CAUSE: Record<string, string> = { ...CODE, ...REASON, ...J.cause };
const PRESET = J.presets;
/** One text per `note` kind; an unknown kind (a journal saved by another app version) reads "Note". */
const NOTES: Record<Extract<JournalEvent, { k: 'note' }>['what'], string> = {
  refererDropped: J.refererDropped,
};
const FAILED = J.failed;
const WINDOW_MS = 30 * 60_000;

/** `HH:MM:SS` local time today; `DD/MM HH:MM:SS` on other days. */
export function logTime(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? time : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

/** One line per event; a multiview window's events start with "Window N" (slot + 1). */
export function eventText(e: JournalEvent): string {
  const text = baseText(e);
  return e.tile === undefined ? text : join(J.window(e.tile + 1), text);
}

const others = (n: number | undefined) => n !== undefined && J.others(n);

function baseText(e: JournalEvent): string {
  switch (e.k) {
    case 'page':
      if (e.what === 'hidden') return J.backgrounded;
      if (e.what === 'visible') return J.foregrounded;
      return e.nav === 'reload' ? J.reload : J.started;
    case 'play':
      return join(J.play, (e.channel && stripUrls(e.channel)) || J.channel, PRESET[e.preset]);
    case 'open':
      return join(J.connect(e.attempt), e.urlIndex > 0 && J.otherFormat, others(e.concurrent));
    case 'playing':
      return join(J.playing, e.engine, e.firstFrameMs !== undefined && J.toPicture(secs(e.firstFrameMs)));
    case 'stall':
      return e.phase === 'start'
        ? join(J.stall, e.bufferAheadS !== undefined && SETTINGS_COPY.diagnostics.buffered(e.bufferAheadS.toFixed(1)))
        : join(J.stallOver, secs(e.durationMs));
    case 'ladder':
      if (e.action === 'gapJump') return J.gap;
      if (e.action === 'seekLive') return J.seekLive;
      return join(J.stuck, e.reason !== undefined && REASON[e.reason]);
    case 'error':
      return join(J.error, CODE[e.code] ?? e.code, e.httpStatus !== undefined && `HTTP ${e.httpStatus}`, e.detail, e.engine);
    case 'reconnect':
      return join(J.reconnect, CAUSE[e.cause] ?? e.cause, `${e.delayMs} ms`);
    case 'alternate':
      return J.alternate;
    case 'rateWait':
      return join(J.waiting, J.waitingReason, secs(e.delayMs));
    case 'drift': {
      const where = [e.behindS !== undefined && J.behind(Math.round(e.behindS)), J.target(e.targetS.toFixed(1))] as const;
      if (e.action === 'seek') return join(J.caughtUp, ...where);
      if (e.action === 'reopen') return join(J.restarted, ...where);
      return join(e.rate === undefined || e.rate === 1 ? J.normalSpeed : J.speed(e.rate), ...where);
    }
    case 'failed':
      return FAILED[e.reason];
    case 'giveUpRetry':
      return J.giveUpRetry;
    case 'catchupMissing':
      return join(J.catchupMissing, e.mode, e.httpStatus !== undefined && `HTTP ${e.httpStatus}`);
    case 'stop':
      return J.stopped;
    case 'note':
      return NOTES[e.what] ?? J.note;
    case 'app':
      return join(J.appFault, e.what, e.name);
    case 'audio':
      return e.action === 'switch' ? join(J.audioSwitched, e.from, e.to, e.because) : J.noAudio;
    case 'engineSwitch':
      return join(J.playerSwitched, J.switchedTo(e.from, e.to), e.reason);
    case 'beta':
      return join(J.beta, e.what);
    case 'tileRefused':
      return join(e.httpStatus === undefined ? J.refused : J.refusedHttp(e.httpStatus), others(e.concurrent),
        e.scope === 'tile' ? J.keptOnWindow : J.sourcePaused);
    case 'displaced':
      return J.displaced(secs(e.afterMs), e.byTile + 1);
    case 'pingPong':
      return J.pingPong;
    case 'escalated':
      return J.escalated;
  }
}

export function formatEvent(e: JournalEvent, now: number): { time: string; text: string } {
  return { time: logTime(e.t, now), text: eventText(e) };
}

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
  if (stalls + reconnects + reloads === 0) return J.noProblems;
  const parts: string[] = [];
  if (stalls > 0) parts.push(J.stalls(stalls));
  if (reconnects > 0) {
    const [top, n] = [...causes.entries()].sort((a, b) => b[1] - a[1])[0]!;
    parts.push(J.topCause(J.reconnects(reconnects), CAUSE[top] ?? top, n));
  }
  if (reloads > 0) parts.push(J.reloads(reloads));
  return J.summary(parts.join(', '));
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
