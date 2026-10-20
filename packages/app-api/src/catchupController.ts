/**
 * Catch-up in the worker (spec 2026-10-20-catch-up §3.4): the URL for a programme, and the lazy Xtream refinement of
 * the focused Guide row. URLs are built here, on the device, and carry credentials: never logged.
 */
import {
  applyShift, archiveState, buildCatchupUrl, epgKey, pickZone, playableState, zoneLabel,
  type ArchiveState, type Channel, type Programme, type SourceConfig, type SourceService,
} from '@iptv/core';
import type { ProgrammeLite } from './types.ts';

const HOUR = 3_600_000;
/** One `get_simple_data_table` per channel per this long. */
export const REFINE_EVERY_MS = 30 * 60_000;
/** A refined listing and a stored programme with starts this close are the same programme. */
const SAME_START_MS = 60_000;

interface Refined { sourceId: string; at: number; listings: (Programme & { hasArchive: boolean })[] }

export interface CatchupContext {
  sourceId: string;
  source: SourceConfig;
  /** The channel as the playlist has it (its URL, catch-up and epg key). */
  channel: Channel;
  /** Guide offset plus the channel's `tvg-shift`, hours: displayed = stored + this. */
  shiftHours: number;
}

export interface CatchupControllerDeps {
  service: SourceService;
  now: () => number;
  /** Tells the UI a row's marks or listings changed. */
  onRefined: (channelId: string) => void;
  /** A failure worth a Diagnostics line (name only). */
  note: (message: string) => void;
}

export class CatchupController {
  private readonly refined = new Map<string, Refined>();
  private readonly lastAsked = new Map<string, number>();
  private inFlight = false;
  private templates: { sourceId: string; list: Promise<string[]> } | undefined;

  constructor(private readonly deps: CatchupControllerDeps) {}

  /** The active source changed or its playlist was refreshed: forget refined answers and the template cache. */
  reset(): void {
    this.refined.clear();
    this.lastAsked.clear();
    this.templates = undefined;
  }

  private templatesFor(sourceId: string): Promise<string[]> {
    if (this.templates?.sourceId !== sourceId) {
      const list = this.deps.service.catchupTemplates(sourceId);
      this.templates = { sourceId, list };
      // A failed read is retried next time.
      list.catch(() => { if (this.templates?.list === list) this.templates = undefined; });
    }
    return this.templates.list;
  }

  /** The refined answer of `channelId` on source `sourceId`, when one is held. */
  private refinedFor(sourceId: string, channelId: string): Refined | undefined {
    const r = this.refined.get(channelId);
    return r && r.sourceId === sourceId ? r : undefined;
  }

  /** The panel's own `has_archive` for a programme (displayed start), when the row was refined. */
  private refinedFlag(sourceId: string, channelId: string, start: number, shiftHours: number): boolean | undefined {
    const r = this.refinedFor(sourceId, channelId);
    if (!r) return undefined;
    const shift = shiftHours * HOUR;
    const hit = r.listings.find((l) => Math.abs(l.start + shift - start) < SAME_START_MS);
    return hit?.hasArchive;
  }

  /**
   * Guide rows: adds refined past listings the stored guide lacks (memory only) and the panel's archive flag.
   * `programmes` are displayed times, sorted; the result is too.
   */
  decorate(sourceId: string, channelId: string, programmes: ProgrammeLite[], shiftHours: number, from: number, to: number): ProgrammeLite[] {
    const r = this.refinedFor(sourceId, channelId);
    if (!r) return programmes;
    const shift = shiftHours * HOUR;
    const out = programmes.map((p) => {
      const hit = r.listings.find((l) => Math.abs(l.start + shift - p.start) < SAME_START_MS);
      return hit ? { ...p, archive: hit.hasArchive } : p;
    });
    for (const l of r.listings) {
      const start = l.start + shift;
      const stop = l.stop + shift;
      if (stop <= from || start >= to) continue;
      if (programmes.some((p) => p.start < stop && p.stop > start)) continue;
      const lite: ProgrammeLite = { title: l.title, start, stop, archive: l.hasArchive };
      if (l.desc) lite.desc = l.desc;
      out.push(lite);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** The archive state of a programme (displayed times) with the refined answer when held. */
  state(ctx: CatchupContext, prog: { start: number; stop: number }): ArchiveState {
    const flag = this.refinedFlag(ctx.sourceId, ctx.channel.id, prog.start, ctx.shiftHours);
    return archiveState(ctx.channel.catchup?.days, prog, this.deps.now(), flag);
  }

  /** A refined listing that starts at `start` (displayed), for programmes the stored guide lacks. */
  refinedProgramme(ctx: CatchupContext, start: number): Programme | undefined {
    const r = this.refinedFor(ctx.sourceId, ctx.channel.id);
    const shift = ctx.shiftHours * HOUR;
    const l = r?.listings.find((x) => Math.abs(x.start + shift - start) < SAME_START_MS);
    return l && applyShift(l, ctx.shiftHours);
  }

  /** The refined listing right after `stop` (displayed), when the stored guide lacks it. */
  refinedAfter(ctx: CatchupContext, stop: number): Programme | undefined {
    return this.refinedProgramme(ctx, stop);
  }

  /** URL and step for `prog` (displayed) from `offsetMs` in; undefined when the data cannot build one. */
  async build(ctx: CatchupContext, prog: { start: number; stop: number }, offsetMs: number) {
    const c = ctx.channel.catchup;
    if (!c) return undefined;
    const templates = c.tpl === undefined ? [] : await this.templatesFor(ctx.sourceId);
    const zone = pickZone({
      ...(ctx.source.catchupOffsetMin !== undefined ? { userOffsetMin: ctx.source.catchupOffsetMin } : {}),
      ...(c.corrMin !== undefined ? { playlistCorrMin: c.corrMin } : {}),
      ...(ctx.source.serverTimeZone ? { serverTimeZone: ctx.source.serverTimeZone } : {}),
      ...(ctx.source.serverOffsetMin !== undefined ? { serverOffsetMin: ctx.source.serverOffsetMin } : {}),
    }).zone;
    return buildCatchupUrl(ctx.channel, templates, prog, offsetMs, zone, this.deps.now(), { xtream: ctx.source.kind === 'xtream' });
  }

  /**
   * Xtream only: one `get_simple_data_table` for the channel, at most every `REFINE_EVERY_MS` and one in flight
   * (others are dropped, never queued: the focus moved on). Spaced from other API calls by the short-EPG slot.
   */
  async refine(ctx: CatchupContext): Promise<void> {
    const { sourceId, source, channel } = ctx;
    if (source.kind !== 'xtream' || !channel.catchup || this.inFlight) return;
    const streamId = Number(/:x(\d+)$/.exec(channel.id)?.[1]);
    if (!streamId) return;
    const now = this.deps.now();
    const last = this.lastAsked.get(channel.id);
    if (last !== undefined && now - last < REFINE_EVERY_MS && now >= last) return;
    this.inFlight = true;
    this.lastAsked.set(channel.id, now);
    try {
      const listings = await this.deps.service.archiveTable(sourceId, streamId, epgKey(channel));
      if (!listings) {
        // Skipped (cooldown, refresh, slot dropped): nothing was asked, so another focus may ask again.
        this.lastAsked.delete(channel.id);
        return;
      }
      this.refined.set(channel.id, { sourceId, at: now, listings });
      if (listings.length) this.deps.onRefined(channel.id);
    } catch (err) {
      this.deps.note(`Catch-up listings: ${err instanceof Error ? err.name : 'Error'}`);
    } finally {
      this.inFlight = false;
    }
  }

  /** For Diagnostics: how catch-up times are written for `source`. */
  static zoneText(source: SourceConfig): string {
    return zoneLabel(pickZone({
      ...(source.catchupOffsetMin !== undefined ? { userOffsetMin: source.catchupOffsetMin } : {}),
      ...(source.serverTimeZone ? { serverTimeZone: source.serverTimeZone } : {}),
      ...(source.serverOffsetMin !== undefined ? { serverOffsetMin: source.serverOffsetMin } : {}),
    }));
  }
}

export { playableState };
