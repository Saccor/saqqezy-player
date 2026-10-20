/** The catch-up URL of one programme (spec 2026-10-20-catch-up §1.2–§1.4). Built on the device; never logged. */
import type { Channel } from '../types.ts';
import { flussonicArchiveUrl } from './m3uCatchup.ts';
import { renderTemplate, templateStepMs } from './template.ts';
import { parseXcLiveUrl, xcTimeshiftPhpUrl, xcTimeshiftUrl } from './xc.ts';
import type { CatchupZone } from './zone.ts';

export interface BuiltCatchup {
  /** Carries credentials when the live URL does: never display or log it. */
  url: string;
  /** Xtream sources: the `timeshift.php` form, tried once when the primary fails. */
  alternateUrl?: string;
  /** The smallest start step the URL form can express (60 000 for xc and minute formats, 1 000 otherwise). */
  stepMs: number;
  /** The instant the URL starts at: `prog.start + offsetMs`, floored to `stepMs`. */
  openStart: number;
}

const SHIFT_SUFFIX = '?utc={utc}&lutc={lutc}';

/** `url` plus a query suffix that starts with `?`: the `?` becomes `&` when `url` already has a query. */
function appendQuery(url: string, suffix: string): string {
  return suffix.startsWith('?') && url.includes('?') ? url + '&' + suffix.slice(1) : url + suffix;
}

/**
 * The URL that plays `prog` (displayed times) from `offsetMs` into it. `templates` are the source's interned ones;
 * `zone` the channel's catch-up zone. `xtream`: the source is an Xtream account (adds the php alternate for xc).
 * `ext`: the live format the source plays in (xc), when it differs from the channel URL's.
 * Undefined when the channel has no catch-up or its data cannot build a right URL.
 */
export function buildCatchupUrl(
  ch: Pick<Channel, 'url' | 'cu'>,
  templates: readonly string[],
  prog: { start: number; stop: number },
  offsetMs: number,
  zone: CatchupZone,
  now: number,
  opts: { xtream?: boolean; ext?: 'ts' | 'm3u8' } = {},
): BuiltCatchup | undefined {
  const c = ch.cu;
  if (!c) return undefined;
  const tpl = c.tpl === undefined ? undefined : templates[c.tpl];
  let stepMs = 1000;
  if (c.mode === 'xc') stepMs = 60_000;
  else if ((c.mode === 'default' || c.mode === 'append') && tpl !== undefined) stepMs = templateStepMs(tpl);
  const openStart = Math.floor((prog.start + Math.max(0, offsetMs)) / stepMs) * stepMs;
  const times = { start: openStart, stop: prog.stop, now };
  try {
    switch (c.mode) {
      case 'default':
        return tpl === undefined ? undefined : { url: renderTemplate(tpl, times, zone), stepMs, openStart };
      case 'append':
        return tpl === undefined ? undefined : { url: appendQuery(ch.url, renderTemplate(tpl, times, zone)), stepMs, openStart };
      case 'shift':
        return { url: appendQuery(ch.url, renderTemplate(SHIFT_SUFFIX, times, zone)), stepMs, openStart };
      case 'flussonic': {
        const url = flussonicArchiveUrl(ch.url, Math.floor(openStart / 1000), Math.floor((prog.stop - openStart) / 1000));
        return url ? { url, stepMs, openStart } : undefined;
      }
      case 'xc': {
        const parsed = parseXcLiveUrl(ch.url);
        if (!parsed) return undefined;
        const p = opts.ext ? { ...parsed, ext: opts.ext } : parsed;
        const out: BuiltCatchup = { url: xcTimeshiftUrl(p, openStart, prog.stop, zone), stepMs, openStart };
        if (opts.xtream) out.alternateUrl = xcTimeshiftPhpUrl(p, openStart, prog.stop, zone);
        return out;
      }
      default:
        return undefined;
    }
  } catch {
    // An invalid template (validated at parse time, so only a corrupted record) builds nothing.
    return undefined;
  }
}
