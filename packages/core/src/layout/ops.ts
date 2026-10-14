import { GROUP_ALL, GROUP_FAV, RECENT_MAX } from '../constants.ts';
import {
  emptyLayout, FAV_LIST_ID, MAX_ID_LEN, MAX_IDS, MAX_LISTS, MAX_OPS_PER_BATCH, NAME_MAX, isValidId,
  type ApplyResult, type Layout, type LayoutOp, type SortMode, type UserList,
} from './types.ts';

const LIST_ID_RE = /^[a-z0-9-]{1,32}$/;
const SORT_MODES: readonly string[] = ['provider', 'number', 'name'];
const GROUP_PREFIX = 'g:';
const LIST_PREFIX = 'list:';
const HAS = Object.prototype.hasOwnProperty;
const has = (rec: object, key: string): boolean => HAS.call(rec, key);

// ---------- helpers ----------

const isStr = (x: unknown): x is string => typeof x === 'string';
const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Safe as a plain-object key (no prototype tampering). */
const safeKey = (k: string): boolean => k !== '__proto__' && isValidId(k);

/** Index loop, so holes in sparse arrays are rejected (`every` would skip them). */
function idList(x: unknown): x is string[] {
  if (!Array.isArray(x) || x.length > MAX_IDS) return false;
  for (let i = 0; i < x.length; i++) if (!isValidId(x[i])) return false;
  return true;
}
const isIndex = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

function validName(name: unknown): string | null {
  if (!isStr(name)) return null;
  const t = name.trim();
  return t.length >= 1 && t.length <= NAME_MAX ? t : null;
}

function validGroupId(id: string): boolean {
  if (id === GROUP_ALL || id === GROUP_FAV) return true;
  if (id.startsWith(LIST_PREFIX)) {
    const rest = id.slice(LIST_PREFIX.length);
    return LIST_ID_RE.test(rest) && rest !== FAV_LIST_ID;
  }
  return id.startsWith(GROUP_PREFIX) && id.length > GROUP_PREFIX.length && safeKey(id);
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Copy of `rec` with `key` set. Computed keys define own properties, so there are no prototype writes. */
function withKey<T>(rec: Record<string, T>, key: string, value: T): Record<string, T> {
  return { ...rec, [key]: value };
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec)) if (k !== key) out[k] = rec[k] as T;
  return out;
}

/**
 * Shallow copy. The reducer never mutates a field in place: an op that changes a field assigns a new
 * array or record to the copy, so untouched fields are shared with the input and nothing is deep-cloned.
 */
export function cloneLayout(l: Layout): Layout {
  return { ...l };
}

// ---------- reducer ----------

type Outcome = { ok: true; changed: boolean } | { ok: false; reason: string };
const OK = (changed: boolean): Outcome => ({ ok: true, changed });
const NO = (reason: string): Outcome => ({ ok: false, reason });

function findList(l: Layout, id: string): UserList | undefined {
  return l.lists.find((x) => x.id === id);
}

function replaceList(l: Layout, next: UserList): void {
  l.lists = l.lists.map((x) => (x.id === next.id ? next : x));
}

/** Appends unseen ids. `null` = nothing to add, `'cap'` = would exceed the size limit. */
function union(cur: readonly string[], ids: readonly string[]): string[] | 'cap' | null {
  const seen = new Set(cur);
  const added: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) { seen.add(id); added.push(id); }
  }
  if (added.length === 0) return null;
  if (cur.length + added.length > MAX_IDS) return 'cap';
  return [...cur, ...added];
}

function removeFromSet(target: readonly string[], ids: readonly string[]): string[] | null {
  const drop = new Set(ids);
  const next = target.filter((x) => !drop.has(x));
  return next.length === target.length ? null : next;
}

function createList(l: Layout, id: string, name: string): Outcome {
  if (!isStr(id) || !LIST_ID_RE.test(id) || id === FAV_LIST_ID) return NO('invalid list id');
  if (findList(l, id)) return NO('list exists');
  const n = validName(name);
  if (n === null) return NO('invalid name');
  if (l.lists.length >= MAX_LISTS) return NO('too many lists');
  l.lists = [...l.lists, { id, name: n, channelIds: [] }];
  return OK(true);
}

function renameList(l: Layout, listId: string, name: string): Outcome {
  if (!isValidId(listId)) return NO('invalid id');
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const n = validName(name);
  if (n === null) return NO('invalid name');
  if (list.name === n) return OK(false);
  replaceList(l, { ...list, name: n });
  return OK(true);
}

function deleteList(l: Layout, listId: string): Outcome {
  if (!isValidId(listId)) return NO('invalid id');
  if (listId === FAV_LIST_ID) return NO('favourites cannot be deleted');
  if (!findList(l, listId)) return NO('unknown list');
  l.lists = l.lists.filter((x) => x.id !== listId);
  const key = LIST_PREFIX + listId;
  if (has(l.sort, key)) l.sort = withoutKey(l.sort, key);
  if (has(l.channelOrder, key)) l.channelOrder = withoutKey(l.channelOrder, key);
  return OK(true);
}

function moveList(l: Layout, listId: string, toIndex: number): Outcome {
  if (!isValidId(listId)) return NO('invalid id');
  if (!isIndex(toIndex)) return NO('invalid index');
  if (listId === FAV_LIST_ID) return NO('favourites cannot be moved');
  const from = l.lists.findIndex((x) => x.id === listId);
  if (from < 0) return NO('unknown list');
  const to = clamp(toIndex, 1, l.lists.length - 1);
  if (to === from) return OK(false);
  const next = l.lists.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as UserList);
  l.lists = next;
  return OK(true);
}

function addToList(l: Layout, listId: string, channelIds: string[]): Outcome {
  if (!isValidId(listId) || !idList(channelIds)) return NO('invalid id');
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const next = union(list.channelIds, channelIds);
  if (next === 'cap') return NO('too many entries');
  if (next === null) return OK(false);
  replaceList(l, { ...list, channelIds: next });
  return OK(true);
}

function removeFromList(l: Layout, listId: string, channelIds: string[]): Outcome {
  if (!isValidId(listId) || !idList(channelIds)) return NO('invalid id');
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const next = removeFromSet(list.channelIds, channelIds);
  if (!next) return OK(false);
  replaceList(l, { ...list, channelIds: next });
  return OK(true);
}

function moveInList(l: Layout, listId: string, channelId: string, toIndex: number): Outcome {
  if (!isValidId(listId) || !isValidId(channelId)) return NO('invalid id');
  if (!isIndex(toIndex)) return NO('invalid index');
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const from = list.channelIds.indexOf(channelId);
  if (from < 0) return NO('channel not in list');
  const to = clamp(toIndex, 0, list.channelIds.length - 1);
  if (to === from) return OK(false);
  const next = list.channelIds.slice();
  next.splice(from, 1);
  next.splice(to, 0, channelId);
  replaceList(l, { ...list, channelIds: next });
  return OK(true);
}

function setHidden(l: Layout, key: 'hiddenChannels' | 'hiddenGroups', ids: string[], hide: boolean): Outcome {
  if (!idList(ids)) return NO('invalid id');
  if (hide) {
    const next = union(l[key], ids);
    if (next === 'cap') return NO('too many entries');
    if (next === null) return OK(false);
    l[key] = next;
    return OK(true);
  }
  const next = removeFromSet(l[key], ids);
  if (!next) return OK(false);
  l[key] = next;
  return OK(true);
}

function rename(l: Layout, key: 'channelNames' | 'groupNames', id: string, name: string | null): Outcome {
  if (!isStr(id) || !safeKey(id)) return NO('invalid id');
  if (name !== null && !isStr(name)) return NO('invalid name');
  const rec = l[key];
  const trimmed = name === null ? '' : name.trim();
  if (trimmed.length > NAME_MAX) return NO('name too long');
  const exists = has(rec, id);
  if (trimmed === '') {
    if (!exists) return OK(false);
    l[key] = withoutKey(rec, id);
    return OK(true);
  }
  if (exists && rec[id] === trimmed) return OK(false);
  if (!exists && Object.keys(rec).length >= MAX_IDS) return NO('too many entries');
  l[key] = withKey(rec, id, trimmed);
  return OK(true);
}

function setGroupOrder(l: Layout, ids: string[]): Outcome {
  if (!idList(ids)) return NO('invalid id');
  const next = dedupe(ids.filter((x) => x.startsWith(GROUP_PREFIX) && x.length > GROUP_PREFIX.length));
  if (sameArray(next, l.groupOrder)) return OK(false);
  l.groupOrder = next;
  return OK(true);
}

function setChannelOrder(l: Layout, groupId: string, ids: string[] | null): Outcome {
  if (!isStr(groupId) || !validGroupId(groupId)) return NO('invalid group id');
  if (ids !== null && !idList(ids)) return NO('invalid id');
  const exists = has(l.channelOrder, groupId);
  if (ids === null) {
    if (!exists) return OK(false);
    l.channelOrder = withoutKey(l.channelOrder, groupId);
    return OK(true);
  }
  const next = dedupe(ids);
  if (exists && sameArray(next, l.channelOrder[groupId] as string[])) return OK(false);
  if (!exists && Object.keys(l.channelOrder).length >= MAX_IDS) return NO('too many entries');
  l.channelOrder = withKey(l.channelOrder, groupId, next);
  return OK(true);
}

function setSort(l: Layout, groupId: string, mode: SortMode): Outcome {
  if (!isStr(groupId) || !validGroupId(groupId)) return NO('invalid group id');
  if (!SORT_MODES.includes(mode)) return NO('invalid sort mode');
  const exists = has(l.sort, groupId);
  if (exists && l.sort[groupId] === mode) return OK(false);
  if (!exists && Object.keys(l.sort).length >= MAX_IDS) return NO('too many entries');
  l.sort = withKey(l.sort, groupId, mode);
  return OK(true);
}

function markWatched(l: Layout, id: string): Outcome {
  if (!isValidId(id)) return NO('invalid id');
  if (l.recent[0] === id) return OK(false);
  l.recent = [id, ...l.recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
  return OK(true);
}

function applyOne(l: Layout, op: LayoutOp): Outcome {
  switch (op.op) {
    case 'createList': return createList(l, op.id, op.name);
    case 'renameList': return renameList(l, op.listId, op.name);
    case 'deleteList': return deleteList(l, op.listId);
    case 'moveList': return moveList(l, op.listId, op.toIndex);
    case 'addToList': return addToList(l, op.listId, op.channelIds);
    case 'removeFromList': return removeFromList(l, op.listId, op.channelIds);
    case 'moveInList': return moveInList(l, op.listId, op.channelId, op.toIndex);
    case 'hideChannels': return setHidden(l, 'hiddenChannels', op.ids, true);
    case 'unhideChannels': return setHidden(l, 'hiddenChannels', op.ids, false);
    case 'hideGroups': return setHidden(l, 'hiddenGroups', op.ids, true);
    case 'unhideGroups': return setHidden(l, 'hiddenGroups', op.ids, false);
    case 'renameChannel': return rename(l, 'channelNames', op.id, op.name);
    case 'renameGroup': return rename(l, 'groupNames', op.id, op.name);
    case 'setGroupOrder': return setGroupOrder(l, op.ids);
    case 'setChannelOrder': return setChannelOrder(l, op.groupId, op.ids);
    case 'setSort': return setSort(l, op.groupId, op.mode);
    case 'setHideNoEpg':
      if (l.hideNoEpg === op.value) return OK(false);
      l.hideNoEpg = op.value;
      return OK(true);
    case 'markWatched': return markWatched(l, op.id);
    default: return NO('unknown op');
  }
}

/**
 * Pure: applies ops in order to a shallow copy of `layout` (see `cloneLayout`); the input is never mutated.
 * Fields no op touched are shared with the input, so treat results as immutable. Rejected ops are reported and skipped.
 */
export function applyOps(layout: Layout, ops: LayoutOp[]): ApplyResult {
  const work = cloneLayout(layout);
  const rejected: ApplyResult['rejected'] = [];
  let changed = false;
  ops.forEach((op, index) => {
    const r = applyOne(work, op);
    if (r.ok) changed ||= r.changed;
    else rejected.push({ index, reason: r.reason });
  });
  if (!changed) return { layout: cloneLayout(layout), changed: false, rejected };
  work.version = layout.version + 1;
  return { layout: work, changed: true, rejected };
}

// ---------- validation ----------

const nameStr = (x: unknown): x is string => isStr(x) && x.length <= MAX_ID_LEN;

/** Runtime shape check for untrusted ops. Semantic validity is decided by applyOps. */
export function isLayoutOp(x: unknown): x is LayoutOp {
  if (!isRec(x) || !isStr(x['op'])) return false;
  switch (x['op']) {
    case 'createList': return isValidId(x['id']) && nameStr(x['name']);
    case 'renameList': return isValidId(x['listId']) && nameStr(x['name']);
    case 'deleteList': return isValidId(x['listId']);
    case 'moveList': return isValidId(x['listId']) && isIndex(x['toIndex']);
    case 'addToList':
    case 'removeFromList': return isValidId(x['listId']) && idList(x['channelIds']);
    case 'moveInList': return isValidId(x['listId']) && isValidId(x['channelId']) && isIndex(x['toIndex']);
    case 'hideChannels':
    case 'unhideChannels':
    case 'hideGroups':
    case 'unhideGroups':
    case 'setGroupOrder': return idList(x['ids']);
    case 'renameChannel':
    case 'renameGroup': return isValidId(x['id']) && (x['name'] === null || nameStr(x['name']));
    case 'setChannelOrder': return isValidId(x['groupId']) && (x['ids'] === null || idList(x['ids']));
    case 'setSort': return isValidId(x['groupId']) && isStr(x['mode']) && SORT_MODES.includes(x['mode']);
    case 'setHideNoEpg': return typeof x['value'] === 'boolean';
    case 'markWatched': return isValidId(x['id']);
    default: return false;
  }
}

/** Runtime check for an untrusted op batch: an array of at most `MAX_OPS_PER_BATCH` valid-shaped ops. */
export function isLayoutOpBatch(x: unknown): x is LayoutOp[] {
  if (!Array.isArray(x) || x.length > MAX_OPS_PER_BATCH) return false;
  for (let i = 0; i < x.length; i++) if (!isLayoutOp(x[i])) return false;
  return true;
}

// ---------- normalisation ----------

function cleanIds(x: unknown, max = MAX_IDS): string[] {
  if (!Array.isArray(x)) return [];
  // Slice first so a hostile huge array costs at most O(max) to scan.
  return dedupe(x.slice(0, max * 2).filter((v): v is string => isValidId(v))).slice(0, max);
}

function cleanName(x: unknown): string | null {
  if (!isStr(x)) return null;
  const t = x.trim().slice(0, NAME_MAX).trim();
  return t === '' ? null : t;
}

function cleanNames(x: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRec(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    const n = cleanName(v);
    if (n !== null && safeKey(k)) out[k] = n;
  }
  return out;
}

function cleanLists(x: unknown): UserList[] {
  const seen = new Set<string>();
  const out: UserList[] = [];
  if (Array.isArray(x)) {
    for (const item of x) {
      if (!isRec(item) || !isStr(item['id'])) continue;
      const id = item['id'];
      if ((id !== FAV_LIST_ID && !LIST_ID_RE.test(id)) || seen.has(id)) continue;
      seen.add(id);
      const name = cleanName(item['name']) ?? (id === FAV_LIST_ID ? 'Favourites' : id);
      out.push({ id, name, channelIds: cleanIds(item['channelIds']) });
    }
  }
  const favAt = out.findIndex((l) => l.id === FAV_LIST_ID);
  const fav: UserList = favAt >= 0
    ? (out.splice(favAt, 1)[0] as UserList)
    : { id: FAV_LIST_ID, name: 'Favourites', channelIds: [] };
  return [fav, ...out].slice(0, MAX_LISTS);
}

/** Repairs a stored or received layout. Unknown shapes yield an empty layout. */
export function normalizeLayout(x: unknown): Layout {
  const base = emptyLayout();
  if (!isRec(x)) return base;

  const channelOrder: Record<string, string[]> = {};
  if (isRec(x['channelOrder'])) {
    for (const [k, v] of Object.entries(x['channelOrder'])) {
      if (validGroupId(k) && Array.isArray(v)) channelOrder[k] = cleanIds(v);
    }
  }
  const sort: Record<string, SortMode> = {};
  if (isRec(x['sort'])) {
    for (const [k, v] of Object.entries(x['sort'])) {
      if (validGroupId(k) && isStr(v) && SORT_MODES.includes(v)) sort[k] = v as SortMode;
    }
  }
  const version = x['version'];
  return {
    version: typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 0,
    lists: cleanLists(x['lists']),
    hiddenChannels: cleanIds(x['hiddenChannels']),
    hiddenGroups: cleanIds(x['hiddenGroups']),
    groupOrder: cleanIds(x['groupOrder']).filter((g) => g.startsWith(GROUP_PREFIX) && g.length > GROUP_PREFIX.length),
    channelOrder,
    channelNames: cleanNames(x['channelNames']),
    groupNames: cleanNames(x['groupNames']),
    sort,
    hideNoEpg: x['hideNoEpg'] === true,
    recent: cleanIds(x['recent'], RECENT_MAX),
  };
}
