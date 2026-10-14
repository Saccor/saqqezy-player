import type { AppSettings, ChannelIndex, GroupInfo, Layout } from '@iptv/core';
import type { RpcError } from './rpc.ts';

export interface ProgrammeLite { title: string; start: number; stop: number; desc?: string }

export interface ChannelRow {
  id: string; number: number; name: string; logo?: string; group: string;
  favourite: boolean; now?: ProgrammeLite; next?: ProgrammeLite;
}

export interface PlayableChannel extends ChannelRow { url: string; alternateUrl?: string }

export interface SourceSummary { id: string; name: string; kind: 'xtream' | 'm3u'; active: boolean }

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
  | { type: 'layoutChanged'; version: number; origin: LayoutOrigin };

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

export interface CompanionChannel {
  id: string;
  /** The playlist name. */
  name: string;
  /** The user's rename, or the playlist name. */
  displayName: string;
  /** Provider group name. */
  group: string;
  number: number;
  logo?: string;
  /** True when the guide has data for the channel, or while guide coverage is unknown. */
  hasEpg: boolean;
}

/** Everything a companion needs to edit the active source's layout. No credentials or stream URLs (logos are URLs). */
export interface CompanionState {
  version: number;
  activeSourceId?: string;
  sources: SourceSummary[];
  groups: ReturnType<ChannelIndex['allProviderGroups']>;
  /** Every channel of the active source, hidden ones included. */
  channels: CompanionChannel[];
  layout: Layout;
  /** False while the guide has not been downloaded: every channel's `hasEpg` is then true by default. */
  coverageKnown: boolean;
}

export interface DiagnosticsInfo {
  appVersion: string;
  sources: { id: string; name: string; kind: string; channels: number; skipped: number; playlistAt: number; epgAt: number }[];
  /** Messages are already credential-free. */
  lastErrors: { at: number; where: string; message: string }[];
  settings: AppSettings;
}
