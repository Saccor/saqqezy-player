import type { Layout } from '../layout/types.ts';
import type { RegionMode } from '../settings.ts';
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
}

export interface RegionRuleInput {
  /** Sure detected region keys per group id (`sureRegionKeys`). */
  keys: Readonly<Record<string, readonly string[]>>;
  codes: readonly string[];
  mode: RegionMode;
}

const NO_KEYS: readonly string[] = [];
const OFF: RegionState = { mode: 'off', requested: 'off', stale: false };

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

export function regionRule(
  groupIds: Iterable<string>, layout: Pick<Layout, 'groupRegion' | 'shownGroups'>, input: RegionRuleInput | undefined,
): RegionRule {
  const keysOf = new Map<string, readonly string[]>();
  const chosen = new Set<string>();
  const ruleHidden = new Set<string>();
  if (!input) {
    for (const gid of groupIds) keysOf.set(gid, NO_KEYS);
    return { keysOf, chosen, ruleHidden, state: OFF };
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
    return { keysOf, chosen, ruleHidden, state: { mode: 'off', requested, stale: false } };
  }
  if (chosen.size === 0) return { keysOf, chosen, ruleHidden, state: { mode: 'off', requested, stale: true } };
  if (requested === 'only') {
    const shown = new Set(layout.shownGroups ?? []);
    for (const [gid, keys] of keysOf) if (keys.length && !chosen.has(gid) && !shown.has(gid)) ruleHidden.add(gid);
  }
  return { keysOf, chosen, ruleHidden, state: { mode: requested, requested, stale: false } };
}
