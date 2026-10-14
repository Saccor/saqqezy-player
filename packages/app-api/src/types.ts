import type { AppSettings, GroupInfo } from '@iptv/core';
import type { CompanionChannel, CompanionSourceSummary, CompanionState } from '@iptv/companion-protocol';
import type { RpcError } from './rpc.ts';

export interface ProgrammeLite { title: string; start: number; stop: number; desc?: string }

export interface ChannelRow {
  id: string; number: number; name: string; logo?: string; group: string;
  favourite: boolean; now?: ProgrammeLite; next?: ProgrammeLite;
}

export interface PlayableChannel extends ChannelRow { url: string; alternateUrl?: string }

export interface SourceSummary { id: string; name: string; kind: 'xtream' | 'm3u'; active: boolean }

// Compile-time drift check: SourceSummary and the companion protocol's copy must stay mutually assignable.
type Assert<T extends true> = T;
export type _SourceSummaryInSync = Assert<
  [SourceSummary] extends [CompanionSourceSummary] ? ([CompanionSourceSummary] extends [SourceSummary] ? true : false) : false
>;

export interface InitState {
  sources: SourceSummary[]; activeSourceId?: string; groups: GroupInfo[];
  lastChannelId?: string; lastGroupId?: string; settings: AppSettings;
}

export type AppEvent =
  | { type: 'progress'; phase: 'playlist' | 'epg'; count: number }
  | { type: 'refreshed'; what: 'playlist' | 'epg'; sourceId: string }
  | { type: 'refreshFailed'; what: 'playlist' | 'epg'; sourceId: string; error: RpcError }
  | { type: 'offline'; value: boolean }
  /** Background short-EPG answers changed the now/next of these channels: re-read their rows. */
  | { type: 'nowNextUpdated'; channelIds: string[] }
  /** The active source's layout changed (version is the new `Layout.version`); `origin` says who changed it. */
  | { type: 'layoutChanged'; version: number; origin: LayoutOrigin }
  /** The phone companion session changed state. */
  | { type: 'companion'; status: CompanionStatus };

/** The TV side of a companion pairing session. `expired` covers every session end that was not `stop()`. */
export interface CompanionStatus {
  state: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'expired';
  /** The paired companion's own label (from its hello). */
  peerLabel?: string;
  expiresAt?: number;
}

/** What the pairing screen shows. Both values are secrets: render them, never log or persist them. */
export interface CompanionStartResult { qrUrl?: string; code?: string; expiresAt: number }

/** What AppApi needs from the companion host (implemented by CompanionHost). */
export interface CompanionControl {
  start(mode: 'qr' | 'code'): Promise<CompanionStartResult>;
  stop(): void;
  status(): CompanionStatus;
  /** Every AppApi event, so the host can forward layout changes and progress. Must not throw. */
  handleEvent(e: AppEvent): void;
}

/** Who applied a layout change: this device's UI, or a paired companion. */
export type LayoutOrigin = 'local' | 'remote';

export interface LayoutOpsResult {
  /** The layout version after the batch (unchanged when nothing changed). */
  version: number;
  /** Ops that were not applied, by their index in the batch. */
  rejected: { index: number; reason: string }[];
}

/** A user list (Favourites included) with its browsable group id and visible channel count. */
export interface ListSummary { id: string; groupId: string; name: string; count: number }

/** Defined in @iptv/companion-protocol (app-api depends on it); re-exported here for compatibility. */
export type { CompanionChannel, CompanionState };

export interface DiagnosticsInfo {
  appVersion: string;
  sources: { id: string; name: string; kind: string; channels: number; skipped: number; playlistAt: number; epgAt: number }[];
  /** Messages are already credential-free. */
  lastErrors: { at: number; where: string; message: string }[];
  settings: AppSettings;
}
