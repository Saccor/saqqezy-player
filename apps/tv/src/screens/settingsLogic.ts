/** Pure helpers for the Settings screen (value steppers, option cycling, labels, diagnostics text). Unit-tested. */
import type { DiagnosticsInfo } from '@iptv/app-api';
import type { LiveInfo } from '@iptv/player';
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { AppSettings } from '@iptv/core';
import { subtitleLanguageLabel } from '../vod/subtitleLogic.ts';

export type SettingsPageId =
  | 'sources' | 'phone' | 'guide' | 'playback' | 'channels' | 'display' | 'storage' | 'diagnostics' | 'about';

export const SETTINGS_PAGES: readonly { id: SettingsPageId; title: string }[] = [
  { id: 'sources', title: 'Sources' },
  { id: 'phone', title: 'Manage on phone or computer' },
  { id: 'guide', title: 'TV guide' },
  { id: 'playback', title: 'Playback' },
  { id: 'channels', title: 'Channels' },
  { id: 'display', title: 'Display' },
  { id: 'storage', title: 'Storage' },
  { id: 'diagnostics', title: 'Diagnostics' },
  { id: 'about', title: 'About' },
];

export const OFFSET_LIMIT = 12;
export const OFFSET_STEP = 0.5;
export const AUTO_REFRESH_OPTIONS = [0, 6, 12, 24] as const;
export const FORMAT_OPTIONS = ['ts', 'm3u8'] as const;
export const LIVE_DELAY_OPTIONS = ['low', 'balanced', 'stable'] as const;
export const liveDelayLabel = (v: AppSettings['liveDelay']): string =>
  (v === 'low' ? 'Low' : v === 'stable' ? 'Stable' : 'Balanced (default)');
/** Same choices as the Player's sleep timer (and core's sanitizer). */
export const SLEEP_DEFAULT_OPTIONS = [0, 15, 30, 60, 90, 120] as const;
/** Errors shown on the Diagnostics page (most recent first). */
export const MAX_ERRORS = 4;

/** EPG offset after one Left (-1) or Right (+1): 0.5 h steps on the half-hour grid, clamped to ±12 h. */
export function stepOffset(hours: number, dir: 1 | -1): number {
  const clamp = (h: number) => Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, h));
  const snapped = clamp(Math.round((Number.isFinite(hours) ? hours : 0) / OFFSET_STEP) * OFFSET_STEP);
  return clamp(snapped + dir * OFFSET_STEP) + 0;
}

export function offsetLabel(hours: number): string {
  if (hours === 0) return '0 h';
  return `${hours > 0 ? '+' : '−'}${Math.abs(hours)} h`;
}

/** The option after (`dir` 1) or before (-1) `current`, wrapping; an unknown value starts at the first option. */
export function cycleOption<T>(options: readonly T[], current: T, dir: 1 | -1 = 1): T {
  const i = options.indexOf(current);
  if (i === -1) return options[0]!;
  return options[(i + dir + options.length) % options.length]!;
}

export const autoRefreshLabel = (h: number): string => (h <= 0 ? 'Never' : `${h} h`);
export const formatLabel = (f: AppSettings['preferredFormat']): string => (f === 'm3u8' ? 'HLS (m3u8)' : 'TS (default)');
export const sleepDefaultLabel = (m: number): string => (m <= 0 ? 'Off' : `${m} min`);
export const onOff = (b: boolean): string => (b ? 'On' : 'Off');

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date and time `YYYY-MM-DD HH:MM`; 0 (never happened) is "Never". */
export function formatTime(ts: number): string {
  if (!ts || ts <= 0) return 'Never';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Defence in depth for anything shown on Diagnostics: core already scrubs error messages, but every URL and
 * `user:pass@host` form is replaced here too, so no address or login can reach the screen.
 */
export function stripUrls(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/\S+@\S+/g, '[link]')
    // Bare `host:port/path` or `host:port`.
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}(?:\/\S*)?/gi, '[link]')
    // Dotted hosts followed by a path or port: `example.test/x`, `example.test:80`.
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?=[/:])\S*/gi, '[link]')
    // Login values in query strings or free text.
    .replace(/\b(?:user(?:name)?|pass(?:word)?)=\S*/gi, '[link]');
}

/**
 * The value to restore when a settings save fails: the pre-change settings, but only if no newer save has
 * started since (a newer change owns the state then).
 */
export function rollbackTarget<T>(previous: T | undefined, seq: number, latestSeq: number): T | undefined {
  return seq === latestSeq ? previous : undefined;
}

const KIND_LABEL: Record<string, string> = { xtream: 'Xtream', m3u: 'M3U' };

/** Raw display and engine facts for Diagnostics, gathered by `readDeviceInfo` (all optional; nothing is required). */
export interface DeviceInfo {
  innerWidth?: number;
  innerHeight?: number;
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  /** `designScale()` from the video layer. */
  designScale?: number;
  userAgent?: string;
  /** Tizen only: `tizen.systeminfo` platform.version capability. */
  tizenPlatformVersion?: string;
  /** Tizen only: `webapis.productinfo.getRealModel()`. */
  tizenModel?: string;
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const size = (w?: number, h?: number): string => (isNum(w) && isNum(h) ? `${Math.round(w)}\u00d7${Math.round(h)}` : 'unknown');
/** Short, safe text from a platform string: printable ASCII only, capped. */
const clean = (v: string): string => v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40);

/** Only the Tizen and Chrome version substrings of a user agent (never the whole string). */
export function uaVersions(ua: string | undefined): string {
  const tizen = /Tizen[ /](\d+(?:\.\d+)*)/.exec(ua ?? '')?.[1];
  const chrome = /Chrom(?:e|ium)\/(\d+(?:\.\d+)*)/.exec(ua ?? '')?.[1];
  const parts = [tizen ? `Tizen ${tizen}` : '', chrome ? `Chrome ${chrome}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' \u00b7 ') : 'unknown';
}

/** Display and engine lines: viewport, screen, pixel ratio, design scale, (Tizen) platform version and model, engine. */
export function screenLines(d: DeviceInfo, platform: string): [string, string][] {
  const scale = isNum(d.designScale) ? d.designScale.toFixed(2) : 'unknown';
  const ratio = isNum(d.devicePixelRatio) ? String(Math.round(d.devicePixelRatio * 100) / 100) : 'unknown';
  const lines: [string, string][] = [
    ['Viewport', `${size(d.innerWidth, d.innerHeight)} \u00b7 design scale ${scale}`],
    ['Screen', `${size(d.screenWidth, d.screenHeight)} \u00b7 pixel ratio ${ratio}`],
  ];
  if (platform === 'tizen') {
    const version = d.tizenPlatformVersion ? clean(d.tizenPlatformVersion) : '';
    const model = d.tizenModel ? clean(d.tizenModel) : '';
    lines.push(['Device', `Tizen ${version || 'version unknown'} \u00b7 ${model || 'model unknown'}`]);
  }
  lines.push(['Engine', uaVersions(d.userAgent)]);
  return lines;
}

/**
 * Diagnostics as label/value lines. Built from a whitelist of fields only: no source id, server, playlist URL,
 * username or password is ever read, and free text (source names, error messages) goes through `stripUrls`.
 */
export function diagnosticsLines(info: DiagnosticsInfo, env: { platform: string; device?: DeviceInfo }): [string, string][] {
  const lines: [string, string][] = [
    ['App version', info.appVersion],
    ['Platform', env.platform],
    ...(env.device ? screenLines(env.device, env.platform) : []),
  ];
  if (info.sources.length === 0) lines.push(['Sources', 'None']);
  info.sources.forEach((s, i) => {
    const kind = KIND_LABEL[s.kind] ?? 'Other';
    lines.push([`Source ${i + 1}`, `${stripUrls(s.name)} · ${kind} · ${s.channels} channels, ${s.skipped} skipped`]);
    lines.push(['', `Channels updated ${formatTime(s.playlistAt)} · Guide updated ${formatTime(s.epgAt)}`]);
  });
  const errors = [...info.lastErrors].sort((a, b) => b.at - a.at).slice(0, MAX_ERRORS);
  if (errors.length === 0) lines.push(['Errors', 'None']);
  for (const e of errors) lines.push([`Error ${formatTime(e.at)}`, `${stripUrls(e.where)}: ${stripUrls(e.message)}`]);
  const st = info.settings;
  lines.push(
    ['Guide offset', offsetLabel(st.epgOffsetHours)],
    ['Stream format', formatLabel(st.preferredFormat)],
    ['Live delay', liveDelayLabel(st.liveDelay)],
    ['Auto-refresh', autoRefreshLabel(st.autoRefreshHours)],
    ['Sleep timer', sleepDefaultLabel(st.sleepTimerMinutes)],
    ['Clock', onOff(st.showClock)],
    ['Subtitle language', subtitleLanguageLabel(st.subtitleLanguage)],
  );
  return lines;
}

// ---- Channels page: hide-without-guide toggle and "My lists" ----

export const HIDE_NO_EPG_UNAVAILABLE = 'Available after the TV guide has been downloaded.';
export const HIDE_NO_EPG_NO_GUIDE = 'This source has no TV guide.';
export const HIDE_NO_EPG_HELP = 'Channels with no programme information are hidden everywhere except your lists.';

/** What the worker knows about the active source's TV guide (`AppApi.guideStatus`). */
export interface GuideStatus { coverageKnown: boolean; hasGuideUrl: boolean }

/** True once the active source's guide coverage is known (the no-guide filter needs it). */
export function guideLoaded(status: GuideStatus): boolean {
  return status.coverageKnown;
}

/**
 * The "Hide channels without TV guide" row: disabled until coverage is known, with the reason as help text
 * ("no TV guide" when the source has no guide address, else "after the guide has been downloaded"). A disabled
 * toggle always reads "Off", whatever the stored setting.
 */
export function hideNoEpgRow(status: GuideStatus, on: boolean): { disabled: boolean; value: string; help: string } {
  if (status.coverageKnown) return { disabled: false, value: onOff(on), help: HIDE_NO_EPG_HELP };
  return { disabled: true, value: 'Off', help: status.hasGuideUrl ? HIDE_NO_EPG_UNAVAILABLE : HIDE_NO_EPG_NO_GUIDE };
}

/**
 * Where "Move up" (-1) / "Move down" (+1) takes the list at `index` of `count` lists, or undefined when it
 * cannot move. Favourites is always first and never moves, so no list moves above it.
 */
export function listMoveTarget(index: number, dir: 1 | -1, count: number): number | undefined {
  if (index < 1 || index >= count) return undefined;
  const to = index + dir;
  return to >= 1 && to < count ? to : undefined;
}

export type ListActionId = 'rename' | 'moveUp' | 'moveDown' | 'delete' | 'cancel';

/** Actions for a list on the Channels page. Favourites can be renamed but not moved or deleted. */
export function listActions(listId: string, index: number, count: number): { id: ListActionId; label: string }[] {
  const fav = listId === 'fav';
  const out: { id: ListActionId; label: string }[] = [{ id: 'rename', label: 'Rename…' }];
  if (!fav && listMoveTarget(index, -1, count) !== undefined) out.push({ id: 'moveUp', label: 'Move up' });
  if (!fav && listMoveTarget(index, 1, count) !== undefined) out.push({ id: 'moveDown', label: 'Move down' });
  if (!fav) out.push({ id: 'delete', label: 'Delete…' });
  out.push({ id: 'cancel', label: 'Cancel' });
  return out;
}

const SOURCE_LABEL = { pdt: 'stream clock', edge: 'stream edge', buffer: 'buffered' } as const;

/**
 * Diagnostics lines for the live delay (no URLs). "Behind live" prefers the stream clock, else the stream edge,
 * else the buffer; when both the clock and the edge are known, the edge (what playback steers by) gets its own line.
 */
export function liveLines(info: LiveInfo): [string, string][] {
  let behind = 'Unknown';
  const edge = info.source !== 'buffer' && info.source !== undefined && info.behindLiveS !== undefined
    ? info.behindLiveS
    : undefined;
  if (info.streamClockBehindS !== undefined) {
    behind = `${Math.round(info.streamClockBehindS)} s (${SOURCE_LABEL.pdt})`;
  } else if (edge !== undefined && info.source !== undefined) {
    behind = `${Math.round(edge)} s (${SOURCE_LABEL[info.source]})`;
  } else if (info.bufferAheadS !== undefined) {
    behind = `${info.bufferAheadS.toFixed(1)} s buffered`;
  }
  const edgeLine: [string, string][] = info.streamClockBehindS !== undefined && edge !== undefined
    ? [['Behind stream edge', `${Math.round(edge)} s`]]
    : [];
  return [
    ['Behind live', behind],
    ...edgeLine,
    ['Live target', `${info.targetS.toFixed(1)} s`],
    ['Stalls / reconnects', `${info.stalls} / ${info.reconnects}`],
  ];
}
