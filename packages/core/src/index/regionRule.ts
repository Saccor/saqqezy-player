import type { Layout } from '../layout/types.ts';
import type { RegionMode } from '../settings.ts';
import { codeIndexOf, pickRank } from './countryFold.ts';
import { isSure, regionKeys, type GroupRegion } from '../text/regions.ts';

/**
 * Your countries over provider groups (report 2026-10-20 §2.2), pure, shared by the TV's `ChannelIndex` and the phone
 * companion so both agree: user hidden > `shownGroups` > rule. `only` hides groups of other countries; groups with no
 * region (none detected, a "Not sure" guess, or an override of []) are never hidden.
 */

export interface RegionState {
  /** The mode in effect: 'off' when stale. */
  mode: RegionMode;
  /** The mode the settings ask for. */
  requested: RegionMode;
  /** Countries were chosen but no group of this source matches them: the rule is off, the UI shows a notice. */
  stale: boolean;
}

export interface RegionRule {
  /** Region keys per group: the user's override, else a sure detection, else []. */
  keysOf: Map<string, readonly string[]>;
  /** Groups of a chosen country (empty while the rule is off). */
  chosen: Set<string>;
  /** Groups the rule hides (`only`), never ones in `shownGroups`. */
  ruleHidden: Set<string>;
  state: RegionState;
  /** A chosen group's rank: the index in `codes` of its best chosen key (pick order); Infinity for any other group. */
  rankOf(gid: string): number;
}

export interface RegionRuleInput {
  /** Sure detected region keys per group id (`sureRegionKeys`). */
  keys: Readonly<Record<string, readonly string[]>>;
  codes: readonly string[];
  mode: RegionMode;
}

const NO_KEYS: readonly string[] = [];
const OFF: RegionState = { mode: 'off', requested: 'off', stale: false };
const NO_RANK = (): number => Infinity;

/** Sure detections as region keys (what the rule reads, and what the companion state carries). */
export function sureRegionKeys(detected: Readonly<Record<string, GroupRegion>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [gid, r] of Object.entries(detected)) {
    if (!isSure(r)) continue;
    const keys = regionKeys(r);
    if (keys.length) out[gid] = keys;
  }
  return out;
}

/**
 * Provider group ids in the TV's order, shared by `ChannelIndex` and the phone companion: `groupOrder` ids that exist
 * first, then, while the rule is on, the chosen countries' groups by pick order (`rankOf`) then provider order, then
 * the rest in provider order (the user's order always wins).
 */
export function orderProviderGroups(
  providerOrder: readonly string[], groupOrder: readonly string[], exists: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  rule: Pick<RegionRule, 'state' | 'chosen' | 'rankOf'>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gid of groupOrder) {
    if (exists.has(gid) && !seen.has(gid)) { out.push(gid); seen.add(gid); }
  }
  if (rule.state.mode !== 'off') {
    const picked = providerOrder.filter((gid) => rule.chosen.has(gid) && !seen.has(gid));
    // Array sort is stable: provider order stays inside a rank. Ranks may be Infinity, so compare, never subtract.
    picked.sort((x, y) => { const rx = rule.rankOf(x); const ry = rule.rankOf(y); return rx < ry ? -1 : rx > ry ? 1 : 0; });
    for (const gid of picked) { out.push(gid); seen.add(gid); }
  }
  for (const gid of providerOrder) if (!seen.has(gid)) out.push(gid);
  return out;
}

export function regionRule(
  groupIds: Iterable<string>, layout: Pick<Layout, 'groupRegion' | 'shownGroups'>, input: RegionRuleInput | undefined,
): RegionRule {
  const keysOf = new Map<string, readonly string[]>();
  const chosen = new Set<string>();
  const ruleHidden = new Set<string>();
  if (!input) {
    for (const gid of groupIds) keysOf.set(gid, NO_KEYS);
    return { keysOf, chosen, ruleHidden, state: OFF, rankOf: NO_RANK };
  }
  const requested = input.mode;
  const codes = new Set(input.codes);
  const own = layout.groupRegion ?? {};
  for (const gid of groupIds) {
    const keys = Object.prototype.hasOwnProperty.call(own, gid) ? own[gid]! : input.keys[gid] ?? NO_KEYS;
    keysOf.set(gid, keys);
    if (keys.some((k) => codes.has(k))) chosen.add(gid);
  }
  if (requested === 'off' || codes.size === 0) {
    chosen.clear();
    return { keysOf, chosen, ruleHidden, state: { mode: 'off', requested, stale: false }, rankOf: NO_RANK };
  }
  if (chosen.size === 0) return { keysOf, chosen, ruleHidden, state: { mode: 'off', requested, stale: true }, rankOf: NO_RANK };
  if (requested === 'only') {
    const shown = new Set(layout.shownGroups ?? []);
    for (const [gid, keys] of keysOf) if (keys.length && !chosen.has(gid) && !shown.has(gid)) ruleHidden.add(gid);
  }
  const index = codeIndexOf(input.codes);
  const rank = new Map<string, number>();
  for (const gid of chosen) rank.set(gid, pickRank(keysOf.get(gid) ?? NO_KEYS, index));
  return { keysOf, chosen, ruleHidden, state: { mode: requested, requested, stale: false }, rankOf: (gid) => rank.get(gid) ?? Infinity };
}
