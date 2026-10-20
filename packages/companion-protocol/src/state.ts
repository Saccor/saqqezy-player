import type { Layout, ProviderGroupInfo, RegionMode } from '@iptv/core';

/** Your countries as the TV applies them to the active source (protocol 3). */
export interface CompanionRegions {
  mode: RegionMode;
  codes: string[];
  /** Sure detected region keys per group id (`sureRegionKeys`); the layout's `groupRegion` overrides them. */
  keys: Record<string, string[]>;
}

/**
 * The companion's view of the TV state. Defined here (not in app-api) because app-api depends on this
 * package; app-api re-exports these types.
 */

/** Structurally identical to app-api's `SourceSummary`. */
export interface CompanionSourceSummary { id: string; name: string; kind: 'xtream' | 'm3u'; active: boolean }

export interface CompanionChannel {
  id: string;
  /** The playlist name. */
  name: string;
  /** The user's rename. Omitted when it equals `name`: show `displayName ?? name`. */
  displayName?: string;
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
  sources: CompanionSourceSummary[];
  groups: ProviderGroupInfo[];
  /** Every channel of the active source, hidden ones included. */
  channels: CompanionChannel[];
  layout: Layout;
  /** False while the guide has not been downloaded: every channel's `hasEpg` is then true by default. */
  coverageKnown: boolean;
  /** Protocol 3: your countries; absent from older TVs and while the source has no detection yet. */
  regions?: CompanionRegions;
}
