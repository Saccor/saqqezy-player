import type { AppSettings, GroupInfo } from '@iptv/core';
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
  | { type: 'nowNextUpdated'; channelIds: string[] };

export interface DiagnosticsInfo {
  appVersion: string;
  sources: { id: string; name: string; kind: string; channels: number; skipped: number; playlistAt: number; epgAt: number }[];
  /** Messages are already credential-free. */
  lastErrors: { at: number; where: string; message: string }[];
  settings: AppSettings;
}
