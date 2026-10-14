import type { CompanionChannel, CompanionState } from '@iptv/companion-protocol';
import { orderGroupChannels, type Layout, type SortMode } from '@iptv/core';

const GROUP_PREFIX = 'g:';

export interface GroupView {
  id: string;
  /** The user's rename, or the provider name. */
  name: string;
  providerName: string;
  /** Every channel in the group, hidden ones included. */
  count: number;
  hidden: boolean;
}

/** The channel's name as the TV shows it: the layout rename, else the playlist name. */
export function channelLabel(c: CompanionChannel, layout: Layout | undefined): string {
  if (!layout) return c.displayName ?? c.name;
  return Object.prototype.hasOwnProperty.call(layout.channelNames, c.id) ? layout.channelNames[c.id]! : c.name;
}

/**
 * Layout-independent data, computed once per channel list: provider groups in first-appearance order and their
 * members in playlist order. Group names, order, visibility and channel order then come from the (optimistic)
 * layout, so they follow every change at once, without waiting for a new `state`.
 */
export class GroupModel {
  readonly providerOrder: string[] = [];
  readonly members = new Map<string, CompanionChannel[]>();
  readonly byId = new Map<string, CompanionChannel>();

  constructor(readonly channels: readonly CompanionChannel[]) {
    for (const c of channels) {
      this.byId.set(c.id, c);
      const gid = GROUP_PREFIX + c.group;
      let m = this.members.get(gid);
      if (!m) {
        m = [];
        this.members.set(gid, m);
        this.providerOrder.push(gid);
      }
      m.push(c);
    }
  }
}

/** Provider groups in the TV's order: `groupOrder` first, then the rest in provider order (as ChannelIndex). */
export function providerGroups(model: GroupModel, layout: Layout): GroupView[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const gid of layout.groupOrder) {
    if (model.members.has(gid) && !seen.has(gid)) { order.push(gid); seen.add(gid); }
  }
  for (const gid of model.providerOrder) if (!seen.has(gid)) order.push(gid);
  const hidden = new Set(layout.hiddenGroups);
  return order.map((gid) => {
    const providerName = gid.slice(GROUP_PREFIX.length);
    return {
      id: gid,
      name: layout.groupNames[gid] ?? providerName,
      providerName,
      count: model.members.get(gid)?.length ?? 0,
      hidden: hidden.has(gid),
    };
  });
}

export function sortModeOf(layout: Layout, groupId: string): SortMode {
  return layout.sort[groupId] ?? 'provider';
}

export function hasManualOrder(layout: Layout, groupId: string): boolean {
  return (layout.channelOrder[groupId]?.length ?? 0) > 0;
}

/**
 * Every channel of a provider group (hidden ones included) in the TV's order: manual order first, then the sort.
 * The same `orderGroupChannels` the TV's ChannelIndex runs, so the two cannot drift.
 */
export function groupChannels(model: GroupModel, groupId: string, layout: Layout): CompanionChannel[] {
  const src = model.members.get(groupId) ?? [];
  return orderGroupChannels(src, sortModeOf(layout, groupId), layout.channelOrder[groupId], (c) => channelLabel(c, layout));
}

/**
 * "Hide channels without TV guide" needs a guide: without coverage every channel counts as having guide data,
 * so the toggle would do nothing.
 */
export function canHideNoEpg(state: {
  coverageKnown: CompanionState['coverageKnown'];
  channels: readonly Pick<CompanionChannel, 'hasEpg'>[];
}): boolean {
  return state.coverageKnown || state.channels.some((c) => !c.hasEpg);
}
