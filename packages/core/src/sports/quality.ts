/** Ordering of the channels that air one event (spec §4). Pure. */

export function qualityRank(name: string): number {
  if (/\b(?:4k|uhd|2160p?)\b/i.test(name)) return 0;
  if (/\b(?:fhd|1080[pi]?)\b/i.test(name)) return 1;
  if (/\b(?:hd|720p?)\b/i.test(name)) return 2;
  if (/\bsd\b/i.test(name)) return 3;
  return 4;
}

export function isBackupName(name: string): boolean {
  return /\b(?:backup|alt|bkp)\b/i.test(name) || /(?:^|\s)\+\d+\b/.test(name);
}

export interface AiringOrderKey { favourite: boolean; airingNow: boolean; name: string; number: number }

export function compareAirings(a: AiringOrderKey, b: AiringOrderKey): number {
  return Number(b.favourite) - Number(a.favourite)
    || Number(b.airingNow) - Number(a.airingNow)
    || Number(isBackupName(a.name)) - Number(isBackupName(b.name))
    || qualityRank(a.name) - qualityRank(b.name)
    || a.number - b.number;
}
