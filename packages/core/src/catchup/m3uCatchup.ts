/**
 * M3U catch-up attributes to a channel's `ChannelCatchup` (spec 2026-10-20-catch-up §1.2, §3.2): mode aliases,
 * inference, validation and template interning. A channel the app cannot build a right URL for gets no catch-up and
 * is counted as unsupported.
 */
import type { M3uCatchupRaw } from '../m3u/parse.ts';
import type { CatchupMode, ChannelCatchup } from '../types.ts';
import { validTemplate } from './template.ts';
import { parseXcLiveUrl } from './xc.ts';

/** Days when a mode is set without any. */
export const CATCHUP_DEFAULT_DAYS = 3;
export const CATCHUP_MAX_DAYS = 30;
/** Distinct templates kept per source. */
export const CATCHUP_MAX_TEMPLATES = 256;

const MODES: Record<string, CatchupMode> = {
  default: 'default', vod: 'default',
  append: 'append',
  shift: 'shift', timeshift: 'shift',
  flussonic: 'flussonic', 'flussonic-hls': 'flussonic', 'flussonic-ts': 'flussonic', fs: 'flussonic',
  xc: 'xc', xtream: 'xc',
};

/** Interned templates and counts for one playlist ingest. */
export class CatchupCollector {
  readonly templates: string[] = [];
  private readonly index = new Map<string, number>();
  channels = 0;
  unsupported = 0;

  /** The template's index, or undefined past `CATCHUP_MAX_TEMPLATES` distinct ones. */
  intern(tpl: string): number | undefined {
    const hit = this.index.get(tpl);
    if (hit !== undefined) return hit;
    if (this.templates.length >= CATCHUP_MAX_TEMPLATES) return undefined;
    const i = this.templates.length;
    this.templates.push(tpl);
    this.index.set(tpl, i);
    return i;
  }
}

const HLS_SHAPE = /^(https?:\/\/[^?#]*\/[^/?#]+\/)(index|video|mono)\.m3u8(\?[^#]*)?$/i;
const TS_SHAPE = /^(https?:\/\/[^?#]*\/[^/?#]+\/)mpegts(\?[^#]*)?$/i;

/**
 * The Flussonic archive URL of a live URL: `…/<name>/index.m3u8` → `…/<name>/index-<startSec>-<durationSec>.m3u8`,
 * `…/<name>/mpegts` → `…/<name>/timeshift_abs-<startSec>.ts`, the query kept. Undefined for any other shape.
 */
export function flussonicArchiveUrl(url: string, startSec: number, durationSec: number): string | undefined {
  const hls = HLS_SHAPE.exec(url);
  if (hls) return `${hls[1]}${hls[2]}-${startSec}-${durationSec}.m3u8${hls[3] ?? ''}`;
  const ts = TS_SHAPE.exec(url);
  if (ts) return `${ts[1]}timeshift_abs-${startSec}.ts${ts[2] ?? ''}`;
  return undefined;
}

const ABSOLUTE = /^https?:\/\//i;

/**
 * The channel's catch-up from its raw attributes (header defaults already merged) and its stream URL. Undefined when
 * it has none, or when it is unsupported (counted in `col.unsupported`); a supported one is counted in `col.channels`.
 */
export function resolveCatchup(raw: M3uCatchupRaw | undefined, url: string, col: CatchupCollector): ChannelCatchup | undefined {
  if (!raw) return undefined;
  const unsupported = () => {
    col.unsupported++;
    return undefined;
  };
  let mode: CatchupMode | undefined;
  if (raw.mode !== undefined) {
    mode = MODES[raw.mode];
    if (!mode) return unsupported();
  } else if (raw.source) {
    mode = ABSOLUTE.test(raw.source) ? 'default' : 'append';
  } else if (raw.days !== undefined) {
    mode = parseXcLiveUrl(url) ? 'xc' : 'shift';
  } else {
    return undefined;
  }
  const days = raw.days !== undefined && raw.days >= 1 ? Math.min(CATCHUP_MAX_DAYS, Math.floor(raw.days)) : CATCHUP_DEFAULT_DAYS;
  const out: ChannelCatchup = { mode, days };
  if (mode === 'default' || mode === 'append') {
    const src = raw.source;
    if (!src || !validTemplate(src) || (mode === 'default' && !ABSOLUTE.test(src))) return unsupported();
    const tpl = col.intern(src);
    if (tpl === undefined) return unsupported();
    out.tpl = tpl;
  } else if (mode === 'flussonic') {
    if (!flussonicArchiveUrl(url, 0, 0)) return unsupported();
  } else if (mode === 'xc') {
    if (!parseXcLiveUrl(url)) return unsupported();
  }
  if (raw.corrMin !== undefined) out.corrMin = raw.corrMin;
  col.channels++;
  return out;
}
