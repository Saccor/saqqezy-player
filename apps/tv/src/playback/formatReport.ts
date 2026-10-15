import { formatOf, type StreamFormat } from '@iptv/app-api';
import type { SupervisorStatus } from '@iptv/player';

type TwoUrls = { url: string; alternateUrl?: string };

/**
 * Which of `ch`'s two URLs is in flight: false for `url`, true for `alternateUrl`; undefined without an alternate or a
 * match. The URLs carry credentials: they are only compared here, never logged or sent.
 */
export function playedAlternate(ch: TwoUrls | undefined, inFlight: string | undefined): boolean | undefined {
  if (!ch?.alternateUrl || inFlight === undefined) return undefined;
  if (inFlight === ch.alternateUrl) return true;
  if (inFlight === ch.url) return false;
  return undefined;
}

export interface FormatReportDeps {
  onStatus(fn: (s: SupervisorStatus) => void): () => void;
  current(): (TwoUrls & { id: string }) | undefined;
  /** The URL the player has open (`player.currentUrl()`). */
  inFlight(): string | undefined;
  /** `format` is a format name only; the URL never leaves the TV side. */
  report(channelId: string, format: StreamFormat): void;
}

/**
 * On a first frame of a channel with two formats, tells the worker which format played (once per channel and format
 * in a row), so it tries that format first next time (spec 2026-10-15-gentle-source §3.4). Returns the unsubscribe.
 */
export function installFormatReport(d: FormatReportDeps): () => void {
  let last: string | undefined;
  return d.onStatus((s) => {
    if (s.kind !== 'playing') return;
    const ch = d.current();
    const url = d.inFlight();
    // A movie or episode plays through a `vod:` stand-in channel: never a live channel's format.
    if (!ch || ch.id.startsWith('vod:') || url === undefined || playedAlternate(ch, url) === undefined) return;
    const format = formatOf(url);
    const key = `${ch.id}|${format}`;
    if (key === last) return;
    last = key;
    d.report(ch.id, format);
  });
}
