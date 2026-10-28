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
 * A fold key as its parts: `<kind><head>|<tail>` is the key string (`e:<guide id>|…` or `n:<country>|…`). The tail
 * never holds more than one `|` and a country none, so distinct parts always give distinct strings.
 */
interface FoldKey {
  kind: 'e:' | 'n:';
  head: string;
  tail: string;
  /** Guide-id keys: their members' countries. */
  countries: Set<string> | undefined;
  /** Its fold index once a member was placed, else -1. */
  fold: number;
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
  /** Per channel: its fold key, as the parts the key string is made of (the string is built once per fold). */
  const keys: FoldKey[] = new Array(n);
  /** `<base>|<shift>` → guide id → its key: the distinct guide-id keys with that tail. */
  const idKeys = new Map<string, Map<string, FoldKey>>();
  /** `<base>|<shift>` → country ('' for none) → its key, for channels without a guide id. */
  const nameKeys = new Map<string, Map<string, FoldKey>>();
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
      let ks = idKeys.get(tail);
      if (!ks) idKeys.set(tail, (ks = new Map()));
      let k = ks.get(gid);
      if (!k) ks.set(gid, (k = { kind: 'e:', head: gid, tail, countries: undefined, fold: -1 }));
      keys[i] = k;
      if (p.country) (k.countries ??= new Set()).add(p.country);
    } else {
      const country = p.country ?? '';
      let ks = nameKeys.get(tail);
      if (!ks) nameKeys.set(tail, (ks = new Map()));
      let k = ks.get(country);
      if (!k) ks.set(country, (k = { kind: 'n:', head: country, tail, countries: undefined, fold: -1 }));
      keys[i] = k;
      noId.push(i);
    }
  }
  for (const i of noId) {
    const ks = idKeys.get(tails[i]!);
    if (!ks || ks.size !== 1) continue;
    const key: FoldKey = ks.values().next().value!;
    const country = countries[i];
    if (country === undefined || key.countries?.has(country)) keys[i] = key;
  }

  const foldOf = new Int32Array(n);
  const folds: ChannelFold[] = [];
  /** Per fold: its first member without a country, or -1. */
  const plain: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = keys[i]!;
    let fi = k.fold;
    if (fi === -1) {
      fi = folds.length;
      k.fold = fi;
      folds.push({ key: `${k.kind}${k.head}|${k.tail}`, members: [], lead: i, display: '', quality: memberQuality[i]! });
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
