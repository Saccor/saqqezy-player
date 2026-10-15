import type { AppSettings, GroupInfo, SourceCooldown } from '@iptv/core';

export type { SourceCooldown };
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
  /** The active source's refusal cooldown (with an active source only). */
  cooldown?: SourceCooldown;
}

/** A programme airing now that matched a search (times on the displayed, shifted timeline). */
export interface ProgrammeHit { channel: ChannelRow; title: string; start: number; stop: number }
/** A title airing later: its next airing, plus how many more upcoming airings exist across channels. */
export interface TitleHit { title: string; channel: ChannelRow; start: number; stop: number; more: number }
export interface SearchResult {
  channels: ChannelRow[];
  onNow: ProgrammeHit[];
  later: TitleHit[];
  /** The guide's title index is being built or loaded: programme sections are empty for now. */
  guidePending: boolean;
}

export type AppEvent =
  | { type: 'progress'; phase: 'playlist' | 'epg'; count: number }
  | { type: 'refreshed'; what: 'playlist' | 'epg'; sourceId: string }
  | { type: 'refreshFailed'; what: 'playlist' | 'epg'; sourceId: string; error: RpcError }
  | { type: 'offline'; value: boolean }
  /** A source's refusal cooldown changed (a refusal, an answer, a retry, or the end of a wait). */
  | { type: 'cooldown'; sourceId: string; cooldown: SourceCooldown }
  /** Background short-EPG answers changed the now/next of these channels: re-read their rows. */
  | { type: 'nowNextUpdated'; channelIds: string[] }
  /** The title index of `sourceId` was built: re-run an open search. */
  | { type: 'searchReady'; sourceId: string }
  /** The active source's layout changed (version is the new `Layout.version`); `origin` says who changed it. */
  /** `recentOnly`: the batch changed nothing but "recently watched" (a zap); the companion is not told. */
  | { type: 'layoutChanged'; version: number; origin: LayoutOrigin; recentOnly?: boolean }
  /**
   * The active source or the source list changed (added, edited, deleted, switched). `activeSourceId` is the active
   * source afterwards (absent without sources); `origin` says who asked: this device's UI or a paired companion.
   */
  | { type: 'sourcesChanged'; activeSourceId?: string; origin: LayoutOrigin }
  /** The phone companion session changed state. */
  | { type: 'companion'; status: CompanionStatus };

/** Why a session ended (with state `expired`). Built from relay close reasons and local causes; never secret. */
export type CompanionEndReason = 'expired' | 'replaced' | 'rate-limit' | 'quota' | 'unreachable' | 'peer-errors' | 'stopped';

/**
 * The TV side of a companion pairing session. `expired` covers every session end that was not `stop()`.
 * `waiting` also covers a paired session whose companion went quiet (no message for 75 s); it continues.
 */
export interface CompanionStatus {
  state: 'idle' | 'waiting' | 'connected' | 'reconnecting' | 'expired';
  /** The paired companion's own label (from its last hello). */
  peerLabel?: string;
  expiresAt?: number;
  /** With state `expired`: why the session ended. */
  reason?: CompanionEndReason;
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
  /** The companion state's channels, guide coverage or sources changed (no AppEvent says so). Must not throw. */
  stateChanged?(): void;
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
