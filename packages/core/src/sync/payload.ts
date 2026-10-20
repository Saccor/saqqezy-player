import { MAX_ID_LEN, MAX_IDS, NAME_MAX } from '../layout/types.ts';
import { decodeHlc, encodeHlc, isNodeId } from './hlc.ts';
import { SYNC_KINDS, type SyncKind } from './keys.ts';
import { expiredTombstone } from './merge.ts';
import { SFP_LENGTH } from './ref.ts';
import type { ProgressValue, SyncRecord, SyncValue, TracksValue } from './types.ts';

/**
 * The sync payload: a closed schema (v1). Encoding reads only the named fields of each record and checks every value
 * against its kind, so nothing else (a channel, a catalogue item, a programme, a URL, a credential) can ride along;
 * decoding applies the same checks to untrusted input and drops whatever does not fit.
 *
 * Sizes are budgeted uncompressed (`CompressionStream` is Chromium 80+): stamps are shared through a table (a bulk
 * change costs one), entries are tuples, flags are 1/0.
 *
 * ```
 * { v: 1,
 *   n: ['nodeaa', …],                    // node ids
 *   c: ['<wall 9><counter 2><node index base 36>', …],   // stamps
 *   s: { '<sfp>' | '': { '<kind>': [[sid, stampIndex, value, pk?], …] } } }
 * ```
 */
export interface SyncPayload {
  v: 1;
  n: string[];
  c: string[];
  s: Record<string, Partial<Record<SyncKind, PayloadEntry[]>>>;
}

export type PayloadEntry = [sid: string, stamp: number, value: unknown, pk?: string];

/** Uncompressed caps of the mailbox (§6.5). */
export const SNAPSHOT_MAX_BYTES = 2_000_000;
export const DELTA_MAX_BYTES = 64 * 1024;

/** The settings that sync (§6.3). Device-tuned ones (`epgOffsetHours`, `preferredFormat`, `liveDelay`, …) never do. */
export const SYNCED_SETTINGS: ReadonlySet<string> = new Set([
  'subtitleLanguage', 'audioLanguage', 'preferredLanguages', 'combineDuplicates', 'followedTeams', 'regions',
]);

// ---------- value rules ----------

const SFP_RE = new RegExp(`^[A-Za-z0-9_-]{${SFP_LENGTH}}$`);
/** Source-scoped ids without their prefix (`x101`, `m5`, `e12`, `v1a2b3c4d`, `abcd1234-2`): no spaces, no URLs. */
const ITEM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LIST_RE = /^(?:fav|[a-z0-9-]{1,32})$/;
const SORT_MODES: readonly string[] = ['provider', 'number', 'name'];
const TAG_MAX = 64;
const SETTING_LIST_MAX = 200;

const isStr = (x: unknown): x is string => typeof x === 'string';
/** Any synced text: bounded, and never something that looks like a URL. */
const text = (x: unknown, max: number): x is string => isStr(x) && x.length > 0 && x.length <= max && !x.includes('://');
const item = (x: unknown): x is string => isStr(x) && ITEM_RE.test(x);
const listId = (x: unknown): x is string => isStr(x) && LIST_RE.test(x);
const group = (x: unknown): x is string => text(x, MAX_ID_LEN) && x.startsWith('g:') && x.length > 2;
/** Group-like targets of a sort or channel order: a group, a list, All or Favourites. */
const target = (x: unknown): x is string =>
  group(x) || x === 'all' || x === 'fav' || (isStr(x) && x.startsWith('list:') && listId(x.slice(5)));
const int = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

function arrayOf(x: unknown, ok: (e: unknown) => boolean, max = MAX_IDS): string[] | undefined {
  if (!Array.isArray(x) || x.length > max) return undefined;
  for (let i = 0; i < x.length; i++) if (!ok(x[i])) return undefined;
  return (x as string[]).slice();
}

function episode(x: unknown): { id: string; se: number; ep: number } | undefined {
  if (!isObj(x) || !onlyKeys(x, ['id', 'se', 'ep']) || !item(x['id']) || !int(x['se']) || !int(x['ep'])) return undefined;
  return { id: x['id'], se: x['se'], ep: x['ep'] };
}

function progress(x: unknown): ProgressValue | undefined {
  if (!isObj(x) || !onlyKeys(x, ['p', 'd', 'w', 's']) || !int(x['p']) || !int(x['d']) || typeof x['w'] !== 'boolean') return undefined;
  const out: ProgressValue = { p: x['p'], d: x['d'], w: x['w'] };
  if (x['s'] !== undefined) {
    const s = x['s'];
    if (!isObj(s) || !onlyKeys(s, ['id', 'se', 'ep', 'n'])) return undefined;
    const base = episode({ id: s['id'], se: s['se'], ep: s['ep'] });
    if (!base) return undefined;
    out.s = base;
    if (s['n'] !== undefined) {
      const n = episode(s['n']);
      if (!n) return undefined;
      out.s.n = n;
    }
  }
  return out;
}

function tracks(x: unknown): TracksValue | undefined {
  if (!isObj(x) || !onlyKeys(x, ['a', 's'])) return undefined;
  const out: TracksValue = {};
  for (const k of ['a', 's'] as const) {
    if (x[k] === undefined) continue;
    if (!text(x[k], TAG_MAX)) return undefined;
    out[k] = x[k];
  }
  return out;
}

const flag = (x: unknown): boolean | undefined => (typeof x === 'boolean' ? x : x === 1 ? true : x === 0 ? false : undefined);
const nameOrNull = (x: unknown): string | null | undefined => (x === null ? null : text(x, NAME_MAX) ? x : undefined);

function setting(name: string, x: unknown): SyncValue | undefined {
  if (!SYNCED_SETTINGS.has(name)) return undefined;
  if (typeof x === 'boolean') return x;
  if (text(x, TAG_MAX)) return x;
  return arrayOf(x, (e) => text(e, TAG_MAX), SETTING_LIST_MAX);
}

/** Is the sid valid for its kind? */
function sidOk(k: SyncKind, sid: unknown): sid is string {
  switch (k) {
    case 'vp': case 'vf': case 'vt': case 'hc': case 'cn': return item(sid);
    case 'vk': case 'vs': return sid === 'movie' || sid === 'series';
    case 'hg': case 'gn': return group(sid);
    case 'co': case 'so': return target(sid);
    case 'lm': {
      if (!isStr(sid)) return false;
      const bar = sid.indexOf('|');
      return bar > 0 && listId(sid.slice(0, bar)) && item(sid.slice(bar + 1));
    }
    case 'lq': case 'ln': return listId(sid);
    case 'lo': case 'go': case 'ne': return sid === '';
    case 'st': return isStr(sid) && SYNCED_SETTINGS.has(sid);
    default: return false;
  }
}

/** The checked value of a kind (decoded form), or undefined when it does not fit. */
function valueOf(k: SyncKind, sid: string, x: unknown): SyncValue | undefined {
  switch (k) {
    case 'vp': return progress(x);
    case 'vt': return tracks(x);
    case 'vf': case 'vs': case 'hc': case 'hg': case 'lm': case 'ne': return flag(x);
    case 'vk': return x === null ? null : item(x) ? x : undefined;
    case 'cn': case 'gn': case 'ln': return nameOrNull(x);
    case 'lq': return arrayOf(x, item);
    case 'lo': return arrayOf(x, listId);
    case 'go': return arrayOf(x, group);
    case 'co': return x === null ? null : arrayOf(x, item);
    case 'so': return isStr(x) && SORT_MODES.includes(x) ? x : undefined;
    case 'st': return setting(sid, x);
    default: return undefined;
  }
}

/** pk: required for picks and splits, optional for VOD state, absent elsewhere. */
function pkOk(k: SyncKind, pk: unknown): boolean {
  if (k === 'vk' || k === 'vs') return text(pk, MAX_ID_LEN);
  if (k === 'vp' || k === 'vf' || k === 'vt') return pk === undefined || text(pk, MAX_ID_LEN);
  return pk === undefined;
}

const sfpOk = (k: SyncKind, sfp: unknown): sfp is string => (k === 'st' ? sfp === '' : isStr(sfp) && SFP_RE.test(sfp));

/** The record rebuilt from its checked fields only, or undefined. */
function clean(r: unknown): SyncRecord | undefined {
  if (!isObj(r) || !isObj(r['ref'])) return undefined;
  const k = r['k'] as SyncKind;
  const ref = r['ref'];
  if (!SYNC_KINDS.includes(k) || !sfpOk(k, ref['sfp']) || !sidOk(k, ref['sid']) || !pkOk(k, ref['pk'])) return undefined;
  if (!decodeHlc(r['t'] as string)) return undefined;
  const v = valueOf(k, ref['sid'], r['v']);
  if (v === undefined) return undefined;
  const out: SyncRecord = { k, ref: { sfp: ref['sfp'], sid: ref['sid'] }, t: r['t'] as string, v };
  if (ref['pk'] !== undefined) out.ref.pk = ref['pk'] as string;
  return out;
}

const encValue = (k: SyncKind, v: SyncValue): unknown =>
  typeof v === 'boolean' && k !== 'st' ? (v ? 1 : 0) : v;

// ---------- encode / decode ----------

/**
 * Encodes records into a payload. Records that do not fit the schema are dropped (nothing beyond their checked fields
 * is read), as are tombstones older than 90 days.
 */
export function encodePayload(records: readonly SyncRecord[], now: number): SyncPayload {
  const nodes = new Map<string, number>();
  const stamps = new Map<string, number>();
  const out: SyncPayload = { v: 1, n: [], c: [], s: {} };
  for (const raw of records) {
    const r = clean(raw);
    if (!r || expiredTombstone(r, now)) continue;
    const h = decodeHlc(r.t)!;
    let ni = nodes.get(h.node);
    if (ni === undefined) {
      ni = out.n.length;
      nodes.set(h.node, ni);
      out.n.push(h.node);
    }
    const stamp = r.t.slice(0, 11) + ni.toString(36);
    let ci = stamps.get(stamp);
    if (ci === undefined) {
      ci = out.c.length;
      stamps.set(stamp, ci);
      out.c.push(stamp);
    }
    const section = (out.s[r.ref.sfp] ??= {});
    const entries = (section[r.k] ??= []);
    const entry: PayloadEntry = [r.ref.sid, ci, encValue(r.k, r.v)];
    if (r.ref.pk !== undefined) entry.push(r.ref.pk);
    entries.push(entry);
  }
  return out;
}

/** Decodes untrusted payload JSON into checked records; anything outside the schema is dropped, never repaired. */
export function decodePayload(x: unknown): SyncRecord[] {
  if (!isObj(x) || x['v'] !== 1 || !Array.isArray(x['n']) || !Array.isArray(x['c']) || !isObj(x['s'])) return [];
  const nodes = x['n'];
  if (!nodes.every(isNodeId)) return [];
  const stamps: (string | undefined)[] = x['c'].map((c: unknown) => {
    if (!isStr(c) || c.length < 12 || c.length > 16) return undefined;
    const node = nodes[parseInt(c.slice(11), 36)] as string | undefined;
    if (!node || !/^[0-9a-z]+$/.test(c.slice(11))) return undefined;
    const t = c.slice(0, 11) + node;
    return decodeHlc(t) ? encodeHlc(decodeHlc(t)!) : undefined;
  });
  const out: SyncRecord[] = [];
  for (const [sfp, section] of Object.entries(x['s'])) {
    if (!isObj(section)) continue;
    for (const [k, entries] of Object.entries(section)) {
      if (!SYNC_KINDS.includes(k as SyncKind) || !Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!Array.isArray(e) || e.length < 3 || e.length > 4) continue;
        const t = int(e[1]) ? stamps[e[1]] : undefined;
        if (!t) continue;
        const ref: Record<string, unknown> = { sfp, sid: e[0] };
        if (e.length === 4) ref['pk'] = e[3];
        const r = clean({ k, ref, t, v: e[2] });
        if (r) out.push(r);
      }
    }
  }
  return out;
}

/** UTF-8 size of the payload as sent (JSON, uncompressed). */
export function payloadBytes(p: SyncPayload): number {
  return new TextEncoder().encode(JSON.stringify(p)).length;
}
