import { isLayoutOpBatch, isValidId, NAME_MAX, MAX_OPS_PER_BATCH, type Layout, type LayoutOp, type NewSource, type SourceConfig } from '@iptv/core';
import type { CompanionState } from './state.ts';

/** How often a connected companion sends `ping`; the TV treats PEER_TIMEOUT_MS of silence as gone. */
export const PING_INTERVAL_MS = 25_000;

/**
 * The companion protocol version both sides announce: `hello.client.protocol` and `welcome.tv.protocol`.
 * Phone messages newer than the TV's protocol are the companion's responsibility to avoid: it gates features on
 * `welcome.tv.protocol`. A TV that still gets a message with an unknown `t` drops it silently (see
 * `isUnknownPhoneMessage`); a malformed message of a known `t` is a protocol error and counts toward closing.
 *
 * Stale `state`: `layoutChanged` and `state` both carry the layout. A companion ignores a `state` whose
 * `layout.version` is lower than the layout version it already holds (a `layoutChanged` overtook it).
 */
export const PROTOCOL_VERSION = 1;

/**
 * Messages a companion (phone or desktop) sends to the TV.
 * - `getState.haveVersion`: the `state.version` the companion already holds; the TV may answer `stateUnchanged`.
 * - `ping`: presence, every PING_INTERVAL_MS while connected. The TV does not answer it.
 */
export type PhoneToTv =
  | { t: 'hello'; client: { kind: 'phone' | 'desktop'; label: string; protocol: number } }
  | { t: 'getState'; haveVersion?: number }
  | { t: 'ping' }
  | { t: 'getSource'; id: string }
  | { t: 'ops'; baseVersion: number; ops: LayoutOp[] }
  | { t: 'addSource'; input: NewSource }
  | { t: 'updateSource'; source: SourceConfig }
  | { t: 'deleteSource'; id: string }
  | { t: 'setActiveSource'; id: string }
  | { t: 'refresh'; what: 'playlist' | 'epg' | 'both' }
  | { t: 'bye' };

/** Messages the TV sends to a companion. */
export type TvToPhone =
  | { t: 'welcome'; tv: { label: string; appVersion: string; protocol: number } }
  | { t: 'state'; state: CompanionState }
  /** Answer to `getState{ haveVersion }`: the companion's copy (that version) is still current. */
  | { t: 'stateUnchanged'; version: number }
  | { t: 'source'; source: SourceConfig }
  | { t: 'layoutChanged'; version: number; layout: Layout }
  | { t: 'progress'; phase: 'playlist' | 'epg'; count: number }
  | { t: 'result'; requestMsgId: number; ok: boolean; error?: { name: string; message: string } }
  | { t: 'bye' };

/** Longest accepted free-text field (names, labels, URLs, credentials). */
export const MAX_FIELD_LEN = 8192;

/** Longest accepted `hello.label`. */
export const MAX_LABEL_LEN = 128;

type Rec = Record<string, unknown>;

const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_FIELD_LEN;
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isU32 = (x: unknown): x is number => isCount(x) && x <= 0xffffffff;

/** True when `x` has exactly the allowed keys: every key in `required`, and any of `optional`. */
function hasKeys(x: Rec, required: readonly string[], optional: readonly string[] = []): boolean {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(x, k)) return false;
  for (const k of Object.keys(x)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

const nonEmpty = (x: unknown): x is string => isStr(x) && x.length > 0;

function isHttpUrl(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/** A URL with an explicit http: or https: scheme. */
function isHttpUrlStr(x: unknown): boolean {
  if (!nonEmpty(x)) return false;
  try {
    return isHttpUrl(new URL(x));
  } catch {
    return false;
  }
}

/** An Xtream server: an http(s) URL, or a bare host[:port][/path] with no scheme. Any other scheme is rejected. */
function isServerStr(x: unknown): boolean {
  if (!nonEmpty(x)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(x)) return isHttpUrlStr(x);
  try {
    return isHttpUrl(new URL(`http://${x}`));
  } catch {
    return false;
  }
}

const isSourceName = (x: unknown): x is string => isStr(x) && x.length <= NAME_MAX;

/** Allowed keys per layout op type (all required). Anything else is rejected before the core shape check. */
const OP_KEYS: Readonly<Record<string, readonly string[]>> = {
  createList: ['op', 'id', 'name'],
  renameList: ['op', 'listId', 'name'],
  deleteList: ['op', 'listId'],
  moveList: ['op', 'listId', 'toIndex'],
  addToList: ['op', 'listId', 'channelIds'],
  removeFromList: ['op', 'listId', 'channelIds'],
  moveInList: ['op', 'listId', 'channelId', 'toIndex'],
  hideChannels: ['op', 'ids'],
  unhideChannels: ['op', 'ids'],
  hideGroups: ['op', 'ids'],
  unhideGroups: ['op', 'ids'],
  renameChannel: ['op', 'id', 'name'],
  renameGroup: ['op', 'id', 'name'],
  setGroupOrder: ['op', 'ids'],
  setChannelOrder: ['op', 'groupId', 'ids'],
  setSort: ['op', 'groupId', 'mode'],
  setHideNoEpg: ['op', 'value'],
  markWatched: ['op', 'id'],
};

function opsHaveKnownKeys(ops: unknown): boolean {
  if (!Array.isArray(ops) || ops.length > MAX_OPS_PER_BATCH) return false;
  for (const op of ops as unknown[]) {
    if (!isRec(op) || typeof op['op'] !== 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(OP_KEYS, op['op'])) return false;
    if (!hasKeys(op, OP_KEYS[op['op']]!)) return false;
  }
  return true;
}

/**
 * NewSource / SourceConfig check: known kind and correct field types. With `strict` (the TV side), unknown
 * fields are rejected too; without it (the companion side) they are ignored for forward compatibility.
 */
function isSourceShape(x: unknown, withId: boolean, strict: boolean): boolean {
  const limits = strict;
  if (!isRec(x)) return false;
  const id = withId ? ['id'] : [];
  if (withId && !isValidId(x['id'])) return false;
  const keys = (required: string[], optional: string[] = []) =>
    strict ? hasKeys(x, required, optional) : hasKeys(x, required, Object.keys(x));
  if (x['kind'] === 'xtream') {
    return keys(['kind', 'name', 'server', 'username', 'password', ...id])
      && (limits ? isSourceName(x['name']) : isStr(x['name']))
      && (limits ? isServerStr(x['server']) : isStr(x['server']))
      && (limits ? nonEmpty(x['username']) && nonEmpty(x['password']) : isStr(x['username']) && isStr(x['password']));
  }
  if (x['kind'] === 'm3u') {
    return keys(['kind', 'name', 'playlistUrl', ...id], ['epgUrl'])
      && (limits ? isSourceName(x['name']) : isStr(x['name']))
      && (limits ? isHttpUrlStr(x['playlistUrl']) : isStr(x['playlistUrl']))
      && (x['epgUrl'] === undefined || (limits ? isHttpUrlStr(x['epgUrl']) : isStr(x['epgUrl'])));
  }
  return false;
}

/**
 * Strict runtime validation of an untrusted companion message: known `t`, exact field set, correct types,
 * and every op shape-checked (at most MAX_OPS_PER_BATCH). This is the TV's only defence against malformed input.
 */
export function isPhoneToTv(x: unknown): x is PhoneToTv {
  if (!isRec(x)) return false;
  switch (x['t']) {
    case 'hello': {
      const c = x['client'];
      return hasKeys(x, ['t', 'client']) && isRec(c) && hasKeys(c, ['kind', 'label', 'protocol'])
        && (c['kind'] === 'phone' || c['kind'] === 'desktop') && isStr(c['label']) && c['label'].length <= MAX_LABEL_LEN
        && isU32(c['protocol']);
    }
    case 'getState':
      return hasKeys(x, ['t'], ['haveVersion']) && (x['haveVersion'] === undefined || isCount(x['haveVersion']));
    case 'ping':
    case 'bye':
      return hasKeys(x, ['t']);
    case 'getSource':
    case 'deleteSource':
    case 'setActiveSource':
      return hasKeys(x, ['t', 'id']) && isValidId(x['id']);
    case 'ops':
      return hasKeys(x, ['t', 'baseVersion', 'ops']) && isCount(x['baseVersion']) && opsHaveKnownKeys(x['ops'])
        && isLayoutOpBatch(x['ops']);
    case 'addSource':
      return hasKeys(x, ['t', 'input']) && isSourceShape(x['input'], false, true);
    case 'updateSource':
      return hasKeys(x, ['t', 'source']) && isSourceShape(x['source'], true, true);
    case 'refresh':
      return hasKeys(x, ['t', 'what']) && (x['what'] === 'playlist' || x['what'] === 'epg' || x['what'] === 'both');
    default:
      return false;
  }
}

/** The `t` values `isPhoneToTv` knows. */
const PHONE_TO_TV_TYPES: ReadonlySet<string> = new Set([
  'hello', 'getState', 'ping', 'getSource', 'deleteSource', 'setActiveSource', 'ops', 'addSource', 'updateSource',
  'refresh', 'bye',
]);

/**
 * True for a record whose `t` is not one `isPhoneToTv` knows: a message from a newer companion. The TV counts
 * these separately and drops them without closing; malformed messages of a known `t` still count as errors.
 */
export function isUnknownPhoneMessage(x: unknown): boolean {
  return isRec(x) && typeof x['t'] === 'string' && !PHONE_TO_TV_TYPES.has(x['t']);
}

function isSourceSummary(x: unknown): boolean {
  return isRec(x) && typeof x['id'] === 'string' && typeof x['name'] === 'string'
    && (x['kind'] === 'xtream' || x['kind'] === 'm3u') && typeof x['active'] === 'boolean';
}

/** `displayName` is omitted when it equals `name`; the companion then shows `name`. */
function isChannelLike(x: unknown): boolean {
  return isRec(x) && typeof x['id'] === 'string' && typeof x['name'] === 'string'
    && (x['displayName'] === undefined || typeof x['displayName'] === 'string');
}

function isLayoutLike(x: unknown): x is Layout {
  return isRec(x) && isCount(x['version']) && Array.isArray(x['lists']);
}

function isStateLike(x: unknown): x is CompanionState {
  return isRec(x)
    && isCount(x['version'])
    && (x['activeSourceId'] === undefined || typeof x['activeSourceId'] === 'string')
    && Array.isArray(x['sources']) && x['sources'].every(isSourceSummary)
    && Array.isArray(x['groups']) && x['groups'].every(isRec)
    && Array.isArray(x['channels']) && x['channels'].every(isChannelLike)
    && isLayoutLike(x['layout'])
    && typeof x['coverageKnown'] === 'boolean';
}

/**
 * Structural validation of a TV message on the companion side: known `t` and the right field types.
 * Deliberately lenient so an older companion keeps working with a newer TV: unknown extra fields are
 * accepted at every level, and nested payloads (state, layout) are checked at the top level only.
 * The TV is the trusted, paired peer. (`isPhoneToTv`, used by the TV, stays strict.)
 */
export function isTvToPhone(x: unknown): x is TvToPhone {
  if (!isRec(x)) return false;
  switch (x['t']) {
    case 'welcome': {
      const tv = x['tv'];
      return isRec(tv) && typeof tv['label'] === 'string' && typeof tv['appVersion'] === 'string'
        && isU32(tv['protocol']);
    }
    case 'state':
      return isStateLike(x['state']);
    case 'stateUnchanged':
      return isCount(x['version']);
    case 'source':
      return isSourceShape(x['source'], true, false);
    case 'layoutChanged':
      return isCount(x['version']) && isLayoutLike(x['layout']);
    case 'progress':
      return (x['phase'] === 'playlist' || x['phase'] === 'epg') && isCount(x['count']);
    case 'result': {
      const e = x['error'];
      return isU32(x['requestMsgId']) && typeof x['ok'] === 'boolean'
        && (e === undefined || (isRec(e) && typeof e['name'] === 'string' && typeof e['message'] === 'string'));
    }
    case 'bye':
      return true;
    default:
      return false;
  }
}
