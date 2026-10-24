import { countryLabel, type RegionSettings, type VodKind } from '@iptv/core';
import type { CountryChoice, CountryChoices } from './types.ts';

export interface CountryChoicesInput {
  /** Live provider groups: their region keys (override, else sure detection) and whether the user hid them. */
  live: readonly { keys: readonly string[]; hidden: boolean }[];
  /** Per known kind: the sure keys of each category the user has not hidden. */
  vod: readonly { kind: VodKind; keys: readonly (readonly string[])[] }[];
  regions: RegionSettings;
  foldCountries: boolean;
  combineCategories: boolean;
  deviceCountry?: string;
}

const folders = (c: CountryChoice): number => c.live + (c.movies ?? 0) + (c.series ?? 0);

/** Your countries' grid data (spec 2026-10-22-your-countries-flags §Worker API). Pure; O(folders). */
export function buildCountryChoices(input: CountryChoicesInput): CountryChoices {
  const by = new Map<string, CountryChoice>();
  const entry = (key: string): CountryChoice => {
    let c = by.get(key);
    if (!c) by.set(key, (c = { key, label: countryLabel(key), isLanguage: key.startsWith('lang:'), live: 0 }));
    return c;
  };
  for (const g of input.live) {
    if (g.hidden) continue;
    for (const k of g.keys) entry(k).live++;
  }
  for (const v of input.vod) {
    for (const keys of v.keys) {
      for (const k of keys) {
        const c = entry(k);
        if (v.kind === 'movie') c.movies = (c.movies ?? 0) + 1;
        else c.series = (c.series ?? 0) + 1;
      }
    }
  }
  const kinds = new Set(input.vod.map((v) => v.kind));
  for (const c of by.values()) {
    if (kinds.has('movie') && c.movies === undefined) c.movies = 0;
    if (kinds.has('series') && c.series === undefined) c.series = 0;
  }
  const device = input.deviceCountry !== undefined && by.has(input.deviceCountry) ? input.deviceCountry : undefined;
  const choices = [...by.values()].sort((a, b) =>
    (a.key === device ? -1 : b.key === device ? 1 : 0) || folders(b) - folders(a) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const { codes, mode } = input.regions;
  const picked = new Set(mode === 'off' ? [] : codes);
  const hits = (keys: readonly string[]) => keys.some((k) => picked.has(k));
  const counts: CountryChoices['counts'] = { live: 0 };
  for (const g of input.live) if (!g.hidden && hits(g.keys)) counts.live++;
  for (const v of input.vod) {
    const n = v.keys.filter(hits).length;
    if (v.kind === 'movie') counts.movies = n;
    else counts.series = n;
  }
  const out: CountryChoices = {
    choices, regions: { codes: [...codes], mode }, foldCountries: input.foldCountries,
    combineCategories: input.combineCategories, stale: mode !== 'off' && codes.length > 0 && !codes.some((c) => by.has(c)), counts,
  };
  if (device) out.deviceCountry = device;
  return out;
}
