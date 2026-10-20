/**
 * Sync register kinds. Each user write stamps one clock per register it changed, under the key `<kind>:<key>` in the
 * source's `syncMeta` scope. Keys use local ids (the source scope makes them unique); the exporter turns them into
 * `SyncRef`s. The same two-letter kinds name the record kinds of a payload (`payload.ts`).
 *
 * A clock whose element is absent from the hot structure (an unhidden channel, a removed favourite) is that removal's
 * tombstone. Nothing is stamped for state that stays local (`recent`, last channel, volume, device settings).
 */
export const SYNC_KIND = {
  /** VOD progress register: position, duration, watched, series pointer (LWW as a whole, §6.2). Key: item id. */
  progress: 'vp',
  /** VOD favourite (element set). Key: item id. */
  favourite: 'vf',
  /** VOD audio and subtitle choice. Key: item id. */
  tracks: 'vt',
  /** VOD version pick. Key: `<kind>|<title group key>`. */
  pick: 'vk',
  /** VOD "Show separately" (element set). Key: `<kind>|<title group key>`. */
  split: 'vs',
  hiddenChannel: 'hc',
  hiddenGroup: 'hg',
  /** List membership (element set). Key: `<listId>|<channelId>`. */
  listMember: 'lm',
  /** Channel order inside a list (whole array). Key: list id. */
  listChannels: 'lq',
  /** List name and existence (null = deleted). Key: list id. */
  listName: 'ln',
  /** Order of the lists (whole array). Key: empty. */
  listOrder: 'lo',
  channelName: 'cn',
  groupName: 'gn',
  /** Group order (whole array). Key: empty. */
  groupOrder: 'go',
  /** Channel order of a group (whole array, null = provider order). Key: group id. */
  channelOrder: 'co',
  sort: 'so',
  hideNoEpg: 'ne',
  /** Group shown on purpose, over the region rule (element set). Key: group id. */
  shownGroup: 'sg',
  /** The user's region for a group (region keys, null = detection). Key: group id. */
  groupRegion: 'gr',
  /** Movies/series category hidden (element set). Key: `<kind>|<category id>`. */
  hiddenCategory: 'ch',
  /** Movies/series category shown on purpose, over the region rule (element set). Key: `<kind>|<category id>`. */
  shownCategory: 'cs',
  /** Movies/series category order (whole array). Key: kind. */
  categoryOrder: 'cq',
  /** A synced setting (the §6.3 subset). Key: setting name. */
  setting: 'st',
} as const;

export type SyncKind = (typeof SYNC_KIND)[keyof typeof SYNC_KIND];

export const SYNC_KINDS: readonly SyncKind[] = Object.values(SYNC_KIND);

export const clockKey = (kind: SyncKind, key: string): string => `${kind}:${key}`;

/** Splits a clock key back into kind and key; undefined for anything else. */
export function parseClockKey(k: string): { kind: SyncKind; key: string } | undefined {
  const kind = k.slice(0, 2) as SyncKind;
  if (k[2] !== ':' || !SYNC_KINDS.includes(kind)) return undefined;
  return { kind, key: k.slice(3) };
}

/** `<a>|<b>` composite keys (pick, split, list membership). */
export const pairKey = (a: string, b: string): string => `${a}|${b}`;
