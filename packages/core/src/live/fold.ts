import type { Channel } from '../types.ts';
import { parseChannelName } from './channelName.ts';

/** One live channel: every playlist entry that is a stream of it. */
export interface ChannelFold {
  /** `e:<guide id>|<base>|<shift>` or `n:<country>|<base>|<shift>`. Stable across refreshes. */
  key: string;
  /** Channel indexes, playlist order. */
  members: number[];
  /** The member with the lowest channel number: the row's id and number. */
  lead: number;
  /** The cleaned name of the first member without a country prefix, else the lead's. */
  display: string;
  /** Best quality rank among members. */
  quality: number;
}

export interface ChannelFolds {
  /** Channel index → fold index. */
  foldOf: Int32Array;
  folds: ChannelFold[];
  memberQuality: Uint8Array;
  /** 1 when the member is named as a spare feed. */
  memberBackup: Uint8Array;
}

/**
 * Folds a playlist's channels by exact keys (spec 2026-10-19-live-grouping §2.3): a guide id plus the name without
 * the country, else the name with the country; a channel without a guide id joins the one guide-id fold with its
 * name. Timeshift (`+1`), East/West and a different tvg-shift never merge. One pass; nothing compared pairwise.
 */
export function foldChannels(channels: readonly Channel[]): ChannelFolds {
  const n = channels.length;
  const memberQuality = new Uint8Array(n);
  const memberBackup = new Uint8Array(n);
  const displays: string[] = new Array(n);
  const countries: (string | undefined)[] = new Array(n);
  const tails: string[] = new Array(n);
  const keys: string[] = new Array(n);
  /** `<base>|<shift>` → the distinct guide-id keys with it. */
  const idKeys = new Map<string, Set<string>>();
  /** Guide-id key → its members' countries. */
  const idCountries = new Map<string, Set<string>>();
  const noId: number[] = [];

  for (let i = 0; i < n; i++) {
    const c = channels[i]!;
    const p = parseChannelName(c.name);
    memberQuality[i] = p.quality;
    memberBackup[i] = p.backup ? 1 : 0;
    displays[i] = p.display;
    countries[i] = p.country;
    const tail = `${p.base}|${c.epgShift ?? ''}`;
    tails[i] = tail;
    const gid = c.epgId?.trim().toLowerCase();
    if (gid) {
      const key = `e:${gid}|${tail}`;
      keys[i] = key;
      let ks = idKeys.get(tail);
      if (!ks) idKeys.set(tail, (ks = new Set()));
      ks.add(key);
      if (p.country) {
        let cs = idCountries.get(key);
        if (!cs) idCountries.set(key, (cs = new Set()));
        cs.add(p.country);
      }
    } else {
      keys[i] = `n:${p.country ?? ''}|${tail}`;
      noId.push(i);
    }
  }
  for (const i of noId) {
    const ks = idKeys.get(tails[i]!);
    if (!ks || ks.size !== 1) continue;
    const key: string = ks.values().next().value!;
    const country = countries[i];
    if (country === undefined || idCountries.get(key)?.has(country)) keys[i] = key;
  }

  const foldOf = new Int32Array(n);
  const folds: ChannelFold[] = [];
  const byKey = new Map<string, number>();
  /** Per fold: its first member without a country, or -1. */
  const plain: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = keys[i]!;
    let fi = byKey.get(key);
    if (fi === undefined) {
      fi = folds.length;
      byKey.set(key, fi);
      folds.push({ key, members: [], lead: i, display: '', quality: memberQuality[i]! });
      plain.push(-1);
    }
    foldOf[i] = fi;
    const f = folds[fi]!;
    f.members.push(i);
    if (channels[i]!.number < channels[f.lead]!.number) f.lead = i;
    if (memberQuality[i]! < f.quality) f.quality = memberQuality[i]!;
    if (plain[fi] === -1 && countries[i] === undefined) plain[fi] = i;
  }
  for (let fi = 0; fi < folds.length; fi++) {
    const f = folds[fi]!;
    f.display = displays[plain[fi]! >= 0 ? plain[fi]! : f.lead]!;
  }
  return { foldOf, folds, memberQuality, memberBackup };
}
