/** Pure helpers for the Settings screen (value steppers, option cycling, labels, diagnostics text). Unit-tested. */
import type { DiagnosticsInfo } from '@iptv/app-api';
import type { LiveInfo } from '@iptv/player';
import { FOLLOWED_TEAMS_MAX, type AppSettings, type OpenOn } from '@iptv/core';
import type { SettingItem } from '../components/SettingsList.tsx';
import { SETTINGS_COPY } from '../copy.ts';
import { audioLanguageLabel, subtitleLanguageLabel } from '../vod/subtitleLogic.ts';

export type SettingsPageId =
  | 'countries' | 'sources' | 'phone' | 'guide' | 'playback' | 'channels' | 'display' | 'storage' | 'diagnostics' | 'about';

const PAGE = SETTINGS_COPY.pages;
const D = SETTINGS_COPY.diagnostics;
const V = SETTINGS_COPY.values;
const P = SETTINGS_COPY.playback;

export const SETTINGS_PAGES: readonly { id: SettingsPageId; title: string }[] = [
  { id: 'countries', title: PAGE.countries },
  { id: 'sources', title: PAGE.sources },
  { id: 'phone', title: PAGE.phone },
  { id: 'guide', title: PAGE.guide },
  { id: 'playback', title: PAGE.playback },
  { id: 'channels', title: PAGE.channels },
  { id: 'display', title: PAGE.display },
  { id: 'storage', title: PAGE.storage },
  { id: 'diagnostics', title: PAGE.diagnostics },
  { id: 'about', title: PAGE.about },
];

/**
 * Where Settings opens. A deep link (`router.push('settings', { page, focusItem })`: "Choose your countries…", first
 * run's "Change") opens that page focused, and Back from it leaves Settings; otherwise the page remembered last.
 */
export function settingsOpenAt(params: Record<string, unknown> | undefined, remembered: number): { page: number; direct: boolean; focusItem?: string } {
  const i = SETTINGS_PAGES.findIndex((p) => p.id === params?.page);
  if (i < 0) return { page: Math.max(0, Math.min(remembered, SETTINGS_PAGES.length - 1)), direct: false };
  return typeof params?.focusItem === 'string' ? { page: i, direct: true, focusItem: params.focusItem } : { page: i, direct: true };
}

export const OFFSET_LIMIT = 12;
export const OFFSET_STEP = 0.5;
export const AUTO_REFRESH_OPTIONS = [0, 6, 12, 24] as const;
export const FORMAT_OPTIONS = ['ts', 'm3u8'] as const;
export const LIVE_DELAY_OPTIONS = ['low', 'balanced', 'stable'] as const;
export const liveDelayLabel = (v: AppSettings['liveDelay']): string =>
  (v === 'low' ? P.liveDelayLow : v === 'stable' ? P.liveDelayStable : P.liveDelayBalanced);
/** Multiview's Max windows (core's `MaxWindows`). */
export const MAX_WINDOWS_OPTIONS = ['auto', 2, 3, 4, 5, 6] as const;
export const maxWindowsLabel = (v: AppSettings['maxWindows'], ceiling: number): string =>
  (v === 'auto' ? P.maxWindowsAuto(ceiling) : String(v));
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

export const autoRefreshLabel = (h: number): string => (h <= 0 ? V.never : `${h} h`);
export const formatLabel = (f: AppSettings['preferredFormat']): string => (f === 'm3u8' ? P.formatHls : P.formatTs);
export const sleepDefaultLabel = (m: number): string => (m <= 0 ? V.off : P.sleepMinutes(m));
export const onOff = (b: boolean): string => (b ? V.on : V.off);

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date and time `YYYY-MM-DD HH:MM`; 0 (never happened) is "Never". */
export function formatTime(ts: number): string {
  if (!ts || ts <= 0) return V.never;
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
  /** The renderer canvas's drawing buffer in device pixels (TVs cap it at 1920x1080, see `renderScale.ts`). */
  renderWidth?: number;
  renderHeight?: number;
  userAgent?: string;
  /** Tizen only: `tizen.systeminfo` platform.version capability. */
  tizenPlatformVersion?: string;
  /** Tizen only: `webapis.productinfo.getRealModel()`. */
  tizenModel?: string;
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const size = (w?: number, h?: number): string => (isNum(w) && isNum(h) ? `${Math.round(w)}\u00d7${Math.round(h)}` : V.unknown);
/** Short, safe text from a platform string: printable ASCII only, capped. */
const clean = (v: string): string => v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40);

/** Only the Tizen and Chrome version substrings of a user agent (never the whole string). */
export function uaVersions(ua: string | undefined): string {
  const tizen = /Tizen[ /](\d+(?:\.\d+)*)/.exec(ua ?? '')?.[1];
  const chrome = /Chrom(?:e|ium)\/(\d+(?:\.\d+)*)/.exec(ua ?? '')?.[1];
  const parts = [tizen ? D.tizenVersion(tizen) : '', chrome ? D.chromeVersion(chrome) : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' \u00b7 ') : V.unknown;
}

/** Display and engine lines: viewport, screen, pixel ratio, design scale, render buffer, (Tizen) platform version and model, engine. */
export function screenLines(d: DeviceInfo, platform: string): [string, string][] {
  const scale = isNum(d.designScale) ? d.designScale.toFixed(2) : V.unknown;
  const ratio = isNum(d.devicePixelRatio) ? String(Math.round(d.devicePixelRatio * 100) / 100) : V.unknown;
  const lines: [string, string][] = [
    [D.viewport, D.viewportValue(size(d.innerWidth, d.innerHeight), scale)],
    [D.screen, D.screenValue(size(d.screenWidth, d.screenHeight), ratio)],
    [D.render, size(d.renderWidth, d.renderHeight)],
  ];
  if (platform === 'tizen') {
    const version = d.tizenPlatformVersion ? clean(d.tizenPlatformVersion) : '';
    const model = d.tizenModel ? clean(d.tizenModel) : '';
    lines.push([D.device, D.tizenDevice(version || D.versionUnknown, model || D.modelUnknown)]);
  }
  lines.push([D.engine, uaVersions(d.userAgent)]);
  return lines;
}

/** `name: message (code 22, HTTP 503)`; the name is left out when generic or already in the message. */
function errorText(e: Pick<DiagnosticsInfo['lastErrors'][number], 'message' | 'name' | 'code' | 'status'>): string {
  const message = stripUrls(e.message);
  if (!message && e.name) return e.name;
  const showName = e.name && e.name !== 'Error' && !message.includes(e.name);
  const extra = [e.code !== undefined ? `code ${e.code}` : '', e.status !== undefined ? `HTTP ${e.status}` : ''].filter(Boolean).join(', ');
  return `${showName ? `${e.name}: ` : ''}${message}${extra ? ` (${extra})` : ''}`;
}

/** Thousands grouped by hand (`412,000`): the TV engines' `toLocaleString` differ. */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * The guide half of a source's "updated" line: a running import (programmes so far, whole minutes), a failed one
 * (its reason), else the last good import's time.
 */
export function guideStatus(s: DiagnosticsInfo['sources'][number], now: number): string {
  const g = s.guideImport;
  if (g?.stage === 'importing') {
    const min = Math.floor(Math.max(0, now - g.startedAt) / 60_000);
    return D.guideImporting(grouped(g.count), min < 1 ? '<1' : String(min));
  }
  if (g?.stage === 'failed' && g.error) return D.guideFailed(errorText(g.error));
  return D.guideUpdated(formatTime(s.epgAt));
}

/** `123 MB of 2,048 MB`: what the device lets the app keep (whole megabytes, thousands grouped by hand). */
export function storageLine(s: { used: number; quota: number }): string {
  const mb = (bytes: number) => grouped(Math.round(bytes / 1048576));
  return `${mb(s.used)} MB of ${mb(s.quota)} MB`;
}

/**
 * Diagnostics as label/value lines. Built from a whitelist of fields only: no source id, server, playlist URL,
 * username or password is ever read, and free text (source names, error messages) goes through `stripUrls`.
 */
export function diagnosticsLines(info: DiagnosticsInfo, env: { platform: string; device?: DeviceInfo; now?: number }): [string, string][] {
  const now = env.now ?? Date.now();
  const lines: [string, string][] = [
    [D.appVersion, info.appVersion],
    [D.platform, env.platform],
    ...(env.device ? screenLines(env.device, env.platform) : []),
  ];
  if (info.sources.length === 0) lines.push([D.sources, V.none]);
  info.sources.forEach((s, i) => {
    const kind = KIND_LABEL[s.kind] ?? D.kindOther;
    lines.push([D.sourceN(i + 1), D.sourceLine(stripUrls(s.name), kind, s.channels, s.skipped)]);
    lines.push(['', D.channelsUpdated(formatTime(s.playlistAt), guideStatus(s, now))]);
    // Catch-up: counts and how archive times are written (never URLs or templates).
    if (s.catchupChannels || s.catchupUnsupported) {
      const unsupported = s.catchupUnsupported ? D.catchupUnsupported(s.catchupUnsupported) : '';
      lines.push(['', D.catchupLine(s.catchupChannels ?? 0, unsupported)]);
      if (s.catchupTime) lines.push(['', D.catchupTime(stripUrls(s.catchupTime))]);
    }
  });
  if (info.storage) lines.push([D.storage, storageLine(info.storage)]);
  const errors = [...info.lastErrors].sort((a, b) => b.at - a.at).slice(0, MAX_ERRORS);
  if (errors.length === 0) lines.push([D.errors, V.none]);
  for (const e of errors) lines.push([D.errorAt(formatTime(e.at)), `${stripUrls(e.where)}: ${errorText(e)}`]);
  const st = info.settings;
  lines.push(
    [D.guideOffset, offsetLabel(st.epgOffsetHours)],
    [D.streamFormat, formatLabel(st.preferredFormat)],
    [D.liveDelay, liveDelayLabel(st.liveDelay)],
    [D.autoRefresh, autoRefreshLabel(st.autoRefreshHours)],
    [D.sleepTimer, sleepDefaultLabel(st.sleepTimerMinutes)],
    [D.clock, onOff(st.showClock)],
    [D.subtitleLanguage, subtitleLanguageLabel(st.subtitleLanguage)],
    [D.audioLanguage, audioLanguageLabel(st.audioLanguage)],
    [D.exactMatch, onOff(st.subtitleExactMatch)],
  );
  return lines;
}

// ---- Sources page: catch-up time (spec 2026-10-20-catch-up §5.6) ----

/** Auto, then −12 h … +14 h in 15 min steps (ids: 'auto' or the minutes). */
export function catchupOffsetChoices(): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [{ id: 'auto', label: V.auto }];
  for (let m = -12 * 60; m <= 14 * 60; m += 15) out.push({ id: String(m), label: catchupOffsetLabel(m) });
  return out;
}

/** The row the Catch-up time list opens on: the current value (Auto, or a manual time); the top when unknown. */
export function catchupOffsetIndex(choices: readonly { id: string }[], current: number | undefined): number {
  return Math.max(0, choices.findIndex((c) => c.id === (current === undefined ? 'auto' : String(current))));
}

/** `Auto`, or the offset from UTC as `UTC+1:00` / `UTC-3:30`. */
export function catchupOffsetLabel(min: number | undefined): string {
  if (min === undefined) return V.auto;
  const a = Math.abs(min);
  return `UTC${min < 0 ? '-' : '+'}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

/** The choice id back to minutes (undefined = Auto); anything unknown is undefined too. */
export function catchupOffsetFromId(id: string): number | undefined {
  if (id === 'auto') return undefined;
  const n = Number(id);
  return Number.isInteger(n) && n % 15 === 0 && n >= -720 && n <= 840 ? n : undefined;
}

// ---- Channels page: hide-without-guide toggle and "My lists" ----

export const HIDE_NO_EPG_UNAVAILABLE = SETTINGS_COPY.channels.guideUnavailable;
export const HIDE_NO_EPG_NO_GUIDE = SETTINGS_COPY.channels.noGuide;
export const HIDE_NO_EPG_HELP = SETTINGS_COPY.channels.hideHelp;

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
  return { disabled: true, value: V.off, help: status.hasGuideUrl ? HIDE_NO_EPG_UNAVAILABLE : HIDE_NO_EPG_NO_GUIDE };
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
  const out: { id: ListActionId; label: string }[] = [{ id: 'rename', label: SETTINGS_COPY.channels.renameAction }];
  if (!fav && listMoveTarget(index, -1, count) !== undefined) out.push({ id: 'moveUp', label: SETTINGS_COPY.channels.moveUp });
  if (!fav && listMoveTarget(index, 1, count) !== undefined) out.push({ id: 'moveDown', label: SETTINGS_COPY.channels.moveDown });
  if (!fav) out.push({ id: 'delete', label: SETTINGS_COPY.channels.deleteAction });
  out.push({ id: 'cancel', label: SETTINGS_COPY.sources.cancel });
  return out;
}

const SOURCE_LABEL = { pdt: D.sourcePdt, edge: D.sourceEdge, buffer: D.sourceBuffer } as const;

/**
 * Diagnostics lines for the live delay (no URLs). "Behind live" prefers the stream clock, else the stream edge,
 * else the buffer; when both the clock and the edge are known, the edge (what playback steers by) gets its own line.
 */
export function liveLines(info: LiveInfo): [string, string][] {
  let behind: string = D.behindUnknown;
  const edge = info.source !== 'buffer' && info.source !== undefined && info.behindLiveS !== undefined
    ? info.behindLiveS
    : undefined;
  if (info.streamClockBehindS !== undefined) {
    behind = `${Math.round(info.streamClockBehindS)} s (${SOURCE_LABEL.pdt})`;
  } else if (edge !== undefined && info.source !== undefined) {
    behind = `${Math.round(edge)} s (${SOURCE_LABEL[info.source]})`;
  } else if (info.bufferAheadS !== undefined) {
    behind = D.buffered(info.bufferAheadS.toFixed(1));
  }
  const edgeLine: [string, string][] = info.streamClockBehindS !== undefined && edge !== undefined
    ? [[D.behindStreamEdge, `${Math.round(edge)} s`]]
    : [];
  return [
    [D.behindLive, behind],
    ...edgeLine,
    [D.liveTarget, `${info.targetS.toFixed(1)} s`],
    [D.stalls, `${info.stalls} / ${info.reconnects}`],
  ];
}

// ---- Display page: clock, Open on, Teams I follow ----


export const openOnLabel = (v: OpenOn) => (v === 'start' ? SETTINGS_COPY.display.openStart : SETTINGS_COPY.display.openLast);

const MOTION_LABEL = { full: SETTINGS_COPY.display.motionFull, reduced: SETTINGS_COPY.display.motionReduced, off: SETTINGS_COPY.display.motionOff } as const;

/** `motion`: the level in force (the setting, or the system's reduced-motion preference when unset; default Full). */
export function displayItems(st: Pick<AppSettings, 'showClock' | 'openOn' | 'followedTeams' | 'posterSize' | 'motion'>): SettingItem[] {
  const C = SETTINGS_COPY.display;
  return [
    { id: 'clock', label: C.clock, value: onOff(st.showClock), adjustable: true, help: C.clockHelp },
    { id: 'openOn', label: C.openOn, value: openOnLabel(st.openOn), adjustable: true, help: C.openOnHelp },
    { id: 'posterSize', label: C.posterSize, value: st.posterSize === 'compact' ? C.posterCompact : C.posterStandard, adjustable: true,
      help: C.posterHelp },
    { id: 'motion', label: C.motion, value: MOTION_LABEL[st.motion ?? 'full'], adjustable: true, help: C.motionHelp },
    { id: 'teamsHeading', label: C.teams, heading: true },
    ...st.followedTeams.map((t, i): SettingItem => ({ id: `team:${i}`, label: t })),
    { id: 'addTeam', label: C.addTeam, help: C.addTeamHelp },
  ];
}

export function addTeamError(list: string[], name: string): string | undefined {
  const t = name.trim();
  if (!t) return SETTINGS_COPY.display.typeName;
  if (list.some((x) => x.toLowerCase() === t.toLowerCase())) return SETTINGS_COPY.display.alreadyIn;
  if (list.length >= FOLLOWED_TEAMS_MAX) return SETTINGS_COPY.display.listFull(FOLLOWED_TEAMS_MAX);
  return undefined;
}
