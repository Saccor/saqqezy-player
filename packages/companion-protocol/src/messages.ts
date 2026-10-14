import { isLayoutOpBatch, isValidId, type Layout, type LayoutOp, type NewSource, type SourceConfig } from '@iptv/core';
import type { CompanionState } from './state.ts';

/** Messages a companion (phone or desktop) sends to the TV. */
export type PhoneToTv =
  | { t: 'hello'; client: { kind: 'phone' | 'desktop'; label: string } }
  | { t: 'getState' }
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
  | { t: 'welcome'; tv: { label: string; appVersion: string } }
  | { t: 'state'; state: CompanionState }
  | { t: 'source'; source: SourceConfig }
  | { t: 'layoutChanged'; version: number; layout: Layout }
  | { t: 'progress'; phase: 'playlist' | 'epg'; count: number }
  | { t: 'result'; requestMsgId: number; ok: boolean; error?: { name: string; message: string } }
  | { t: 'bye' };

/** Longest accepted free-text field (names, labels, URLs, credentials). */
export const MAX_FIELD_LEN = 8192;

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

/** Strict NewSource / SourceConfig check: known kind, correct field types, no unknown fields. */
function isSourceShape(x: unknown, withId: boolean): boolean {
  if (!isRec(x)) return false;
  const id = withId ? ['id'] : [];
  if (withId && !isValidId(x['id'])) return false;
  if (x['kind'] === 'xtream') {
    return hasKeys(x, ['kind', 'name', 'server', 'username', 'password', ...id])
      && isStr(x['name']) && isStr(x['server']) && isStr(x['username']) && isStr(x['password']);
  }
  if (x['kind'] === 'm3u') {
    return hasKeys(x, ['kind', 'name', 'playlistUrl', ...id], ['epgUrl'])
      && isStr(x['name']) && isStr(x['playlistUrl'])
      && (x['epgUrl'] === undefined || isStr(x['epgUrl']));
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
      return hasKeys(x, ['t', 'client']) && isRec(c) && hasKeys(c, ['kind', 'label'])
        && (c['kind'] === 'phone' || c['kind'] === 'desktop') && isStr(c['label']);
    }
    case 'getState':
    case 'bye':
      return hasKeys(x, ['t']);
    case 'getSource':
    case 'deleteSource':
    case 'setActiveSource':
      return hasKeys(x, ['t', 'id']) && isValidId(x['id']);
    case 'ops':
      return hasKeys(x, ['t', 'baseVersion', 'ops']) && isCount(x['baseVersion']) && isLayoutOpBatch(x['ops']);
    case 'addSource':
      return hasKeys(x, ['t', 'input']) && isSourceShape(x['input'], false);
    case 'updateSource':
      return hasKeys(x, ['t', 'source']) && isSourceShape(x['source'], true);
    case 'refresh':
      return hasKeys(x, ['t', 'what']) && (x['what'] === 'playlist' || x['what'] === 'epg' || x['what'] === 'both');
    default:
      return false;
  }
}

function isSourceSummary(x: unknown): boolean {
  return isRec(x) && typeof x['id'] === 'string' && typeof x['name'] === 'string'
    && (x['kind'] === 'xtream' || x['kind'] === 'm3u') && typeof x['active'] === 'boolean';
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
    && Array.isArray(x['channels']) && x['channels'].every(isRec)
    && isLayoutLike(x['layout'])
    && typeof x['coverageKnown'] === 'boolean';
}

/**
 * Structural validation of a TV message on the companion side: known `t` and the right field types.
 * Nested payloads (state, layout) are checked at the top level only; the TV is the trusted, paired peer.
 */
export function isTvToPhone(x: unknown): x is TvToPhone {
  if (!isRec(x)) return false;
  switch (x['t']) {
    case 'welcome': {
      const tv = x['tv'];
      return isRec(tv) && typeof tv['label'] === 'string' && typeof tv['appVersion'] === 'string';
    }
    case 'state':
      return isStateLike(x['state']);
    case 'source':
      return isSourceShape(x['source'], true);
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
