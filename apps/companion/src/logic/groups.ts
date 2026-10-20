import { REGIONS_PROTOCOL, type CompanionChannel, type CompanionRegions, type CompanionState } from '@iptv/companion-protocol';
import { orderGroupChannels, regionRule, type Layout, type LayoutOp, type SortMode } from '@iptv/core';
import { COPY } from './copy.ts';

const GROUP_PREFIX = 'g:';

export interface GroupView {
  id: string;
  /** The user's rename, or the provider name. */
  name: string;
  providerName: string;
  /** Every channel in the group, hidden ones included. */
  count: number;
  /** Hidden by the user. */
  hidden: boolean;
  /** Hidden by your countries (Show only these) on the TV, not by the user. */
  regionHidden: boolean;
  /** Shown on purpose over your countries. */
  shown: boolean;
}

/**
 * The ops that show or hide a group as the TV does. Showing a group your countries hide needs `showGroups`
 * (protocol 3); an older TV gets `unhideGroups`. Otherwise showing returns the group to the rule.
 */
export function groupShowOps(g: GroupView, show: boolean, tvProtocol: number | undefined): LayoutOp[] {
  if (!show) return [{ op: 'hideGroups', ids: [g.id] }];
  if (g.regionHidden && tvProtocol !== undefined && tvProtocol >= REGIONS_PROTOCOL) return [{ op: 'showGroups', ids: [g.id] }];
  return [{ op: 'unhideGroups', ids: [g.id] }];
}

/** The channel's name as the TV shows it: the layout rename, else the playlist name. */
export function channelLabel(c: CompanionChannel, layout: Layout | undefined): string {
  return labelFromNames(c, layout?.channelNames);
}

/** `channelLabel` from the layout's renames alone (undefined: no layout yet, use the state's `displayName`). */
export function labelFromNames(c: CompanionChannel, names: Readonly<Record<string, string>> | undefined): string {
  if (!names) return c.displayName ?? c.name;
  return Object.prototype.hasOwnProperty.call(names, c.id) ? names[c.id]! : c.name;
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

/**
 * Provider groups in the TV's order (as ChannelIndex): `groupOrder` first, then, with your countries on, the chosen
 * countries' groups, then the rest in provider order. `regions` comes from the TV's state (protocol 3); the region
 * rule is the TV's own (`regionRule`), run on the phone's optimistic layout.
 */
export function providerGroups(model: GroupModel, layout: Layout, regions?: CompanionRegions): GroupView[] {
  const rule = regionRule(model.providerOrder, layout, regions);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const gid of layout.groupOrder) {
    if (model.members.has(gid) && !seen.has(gid)) { order.push(gid); seen.add(gid); }
  }
  if (rule.state.mode !== 'off') for (const gid of model.providerOrder) if (rule.chosen.has(gid) && !seen.has(gid)) { order.push(gid); seen.add(gid); }
  for (const gid of model.providerOrder) if (!seen.has(gid)) order.push(gid);
  const hidden = new Set(layout.hiddenGroups);
  const shown = new Set(layout.shownGroups ?? []);
  return order.map((gid) => {
    const providerName = gid.slice(GROUP_PREFIX.length);
    return {
      id: gid,
      name: layout.groupNames[gid] ?? providerName,
      providerName,
      count: model.members.get(gid)?.length ?? 0,
      hidden: hidden.has(gid),
      regionHidden: rule.ruleHidden.has(gid),
      shown: shown.has(gid),
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
 * Choosing a sort. A custom order always comes before the sort on the TV, so the sort also clears it; when there is
 * one, `confirm` asks first (COPY.replaceCustomOrder). Undefined: the user said no, send nothing.
 */
export function sortChangeOps(
  groupId: string, mode: SortMode, hasManual: boolean, confirm: (question: string) => boolean,
): LayoutOp[] | undefined {
  const ops: LayoutOp[] = [{ op: 'setSort', groupId, mode }];
  if (!hasManual) return ops;
  if (!confirm(COPY.replaceCustomOrder)) return undefined;
  ops.push({ op: 'setChannelOrder', groupId, ids: null });
  return ops;
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
