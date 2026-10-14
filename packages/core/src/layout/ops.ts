import { GROUP_ALL, GROUP_FAV, RECENT_MAX } from '../constants.ts';
import {
  emptyLayout, FAV_LIST_ID, MAX_LISTS, NAME_MAX,
  type ApplyResult, type Layout, type LayoutOp, type SortMode, type UserList,
} from './types.ts';

const LIST_ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX_IDS = 50_000;
const MAX_ID_LEN = 2048;
const SORT_MODES: readonly string[] = ['provider', 'number', 'name'];
const GROUP_PREFIX = 'g:';
const LIST_PREFIX = 'list:';

// ---------- helpers ----------

const isStr = (x: unknown): x is string => typeof x === 'string';
const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Safe as a plain-object key (no prototype tampering). */
const safeKey = (k: string): boolean => k !== '__proto__' && k.length > 0 && k.length <= MAX_ID_LEN;

function validName(name: string): string | null {
  const t = name.trim();
  return t.length >= 1 && t.length <= NAME_MAX ? t : null;
}

function validGroupId(id: string): boolean {
  if (id === GROUP_ALL || id === GROUP_FAV) return true;
  if (id.startsWith(LIST_PREFIX)) return LIST_ID_RE.test(id.slice(LIST_PREFIX.length));
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

// ---------- reducer ----------

type Outcome = { ok: true; changed: boolean } | { ok: false; reason: string };
const OK = (changed: boolean): Outcome => ({ ok: true, changed });
const NO = (reason: string): Outcome => ({ ok: false, reason });

function findList(l: Layout, id: string): UserList | undefined {
  return l.lists.find((x) => x.id === id);
}

function addToSet(target: string[], ids: string[]): boolean {
  const have = new Set(target);
  let changed = false;
  for (const id of ids) {
    if (!have.has(id)) { have.add(id); target.push(id); changed = true; }
  }
  return changed;
}

function removeFromSet(target: string[], ids: string[]): string[] | null {
  const drop = new Set(ids);
  const next = target.filter((x) => !drop.has(x));
  return next.length === target.length ? null : next;
}

function createList(l: Layout, id: string, name: string): Outcome {
  if (!LIST_ID_RE.test(id) || id === FAV_LIST_ID) return NO('invalid list id');
  if (findList(l, id)) return NO('list exists');
  const n = validName(name);
  if (n === null) return NO('invalid name');
  if (l.lists.length >= MAX_LISTS) return NO('too many lists');
  l.lists.push({ id, name: n, channelIds: [] });
  return OK(true);
}

function renameList(l: Layout, listId: string, name: string): Outcome {
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const n = validName(name);
  if (n === null) return NO('invalid name');
  if (list.name === n) return OK(false);
  list.name = n;
  return OK(true);
}

function deleteList(l: Layout, listId: string): Outcome {
  if (listId === FAV_LIST_ID) return NO('favourites cannot be deleted');
  const i = l.lists.findIndex((x) => x.id === listId);
  if (i < 0) return NO('unknown list');
  l.lists.splice(i, 1);
  delete l.sort[LIST_PREFIX + listId];
  delete l.channelOrder[LIST_PREFIX + listId];
  return OK(true);
}

function moveList(l: Layout, listId: string, toIndex: number): Outcome {
  if (listId === FAV_LIST_ID) return NO('favourites cannot be moved');
  const from = l.lists.findIndex((x) => x.id === listId);
  if (from < 0) return NO('unknown list');
  const to = clamp(Math.trunc(toIndex), 1, l.lists.length - 1);
  if (to === from) return OK(false);
  const [item] = l.lists.splice(from, 1);
  l.lists.splice(to, 0, item as UserList);
  return OK(true);
}

function addToList(l: Layout, listId: string, channelIds: string[]): Outcome {
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  return OK(addToSet(list.channelIds, channelIds));
}

function removeFromList(l: Layout, listId: string, channelIds: string[]): Outcome {
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const next = removeFromSet(list.channelIds, channelIds);
  if (!next) return OK(false);
  list.channelIds = next;
  return OK(true);
}

function moveInList(l: Layout, listId: string, channelId: string, toIndex: number): Outcome {
  const list = findList(l, listId);
  if (!list) return NO('unknown list');
  const from = list.channelIds.indexOf(channelId);
  if (from < 0) return NO('channel not in list');
  const to = clamp(Math.trunc(toIndex), 0, list.channelIds.length - 1);
  if (to === from) return OK(false);
  list.channelIds.splice(from, 1);
  list.channelIds.splice(to, 0, channelId);
  return OK(true);
}

function setHidden(l: Layout, key: 'hiddenChannels' | 'hiddenGroups', ids: string[], hide: boolean): Outcome {
  if (hide) return OK(addToSet(l[key], ids));
  const next = removeFromSet(l[key], ids);
  if (!next) return OK(false);
  l[key] = next;
  return OK(true);
}

function rename(rec: Record<string, string>, id: string, name: string | null): Outcome {
  if (!safeKey(id)) return NO('invalid id');
  const trimmed = name === null ? '' : name.trim();
  if (trimmed.length > NAME_MAX) return NO('name too long');
  const has = Object.hasOwn(rec, id);
  if (trimmed === '') {
    if (!has) return OK(false);
    delete rec[id];
    return OK(true);
  }
  if (has && rec[id] === trimmed) return OK(false);
  rec[id] = trimmed;
  return OK(true);
}

function setGroupOrder(l: Layout, ids: string[]): Outcome {
  const next = dedupe(ids.filter((x) => x.startsWith(GROUP_PREFIX) && x.length > GROUP_PREFIX.length));
  if (sameArray(next, l.groupOrder)) return OK(false);
  l.groupOrder = next;
  return OK(true);
}

function setChannelOrder(l: Layout, groupId: string, ids: string[] | null): Outcome {
  if (!validGroupId(groupId)) return NO('invalid group id');
  const has = Object.hasOwn(l.channelOrder, groupId);
  if (ids === null) {
    if (!has) return OK(false);
    delete l.channelOrder[groupId];
    return OK(true);
  }
  const next = dedupe(ids);
  if (has && sameArray(next, l.channelOrder[groupId] as string[])) return OK(false);
  l.channelOrder[groupId] = next;
  return OK(true);
}

function setSort(l: Layout, groupId: string, mode: SortMode): Outcome {
  if (!validGroupId(groupId)) return NO('invalid group id');
  if (!SORT_MODES.includes(mode)) return NO('invalid sort mode');
  if (Object.hasOwn(l.sort, groupId) && l.sort[groupId] === mode) return OK(false);
  l.sort[groupId] = mode;
  return OK(true);
}

function markWatched(l: Layout, id: string): Outcome {
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
    case 'renameChannel': return rename(l.channelNames, op.id, op.name);
    case 'renameGroup': return rename(l.groupNames, op.id, op.name);
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

/** Pure: applies ops in order to a copy of `layout`. Rejected ops are reported and skipped. */
export function applyOps(layout: Layout, ops: LayoutOp[]): ApplyResult {
  const work = structuredClone(layout);
  const rejected: ApplyResult['rejected'] = [];
  let changed = false;
  ops.forEach((op, index) => {
    const r = applyOne(work, op);
    if (r.ok) changed ||= r.changed;
    else rejected.push({ index, reason: r.reason });
  });
  if (!changed) return { layout: structuredClone(layout), changed: false, rejected };
  work.version = layout.version + 1;
  return { layout: work, changed: true, rejected };
}

// ---------- validation ----------

function idArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.length <= MAX_IDS && x.every((v) => isStr(v) && v.length <= MAX_ID_LEN);
}
const idStr = (x: unknown): x is string => isStr(x) && x.length <= MAX_ID_LEN;
const nameStr = (x: unknown): x is string => isStr(x) && x.length <= MAX_ID_LEN;
const idx = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Runtime shape check for untrusted ops. Semantic validity is decided by applyOps. */
export function isLayoutOp(x: unknown): x is LayoutOp {
  if (!isRec(x) || !isStr(x['op'])) return false;
  switch (x['op']) {
    case 'createList': return idStr(x['id']) && nameStr(x['name']);
    case 'renameList': return idStr(x['listId']) && nameStr(x['name']);
    case 'deleteList': return idStr(x['listId']);
    case 'moveList': return idStr(x['listId']) && idx(x['toIndex']);
    case 'addToList':
    case 'removeFromList': return idStr(x['listId']) && idArray(x['channelIds']);
    case 'moveInList': return idStr(x['listId']) && idStr(x['channelId']) && idx(x['toIndex']);
    case 'hideChannels':
    case 'unhideChannels':
    case 'hideGroups':
    case 'unhideGroups':
    case 'setGroupOrder': return idArray(x['ids']);
    case 'renameChannel':
    case 'renameGroup': return idStr(x['id']) && (x['name'] === null || nameStr(x['name']));
    case 'setChannelOrder': return idStr(x['groupId']) && (x['ids'] === null || idArray(x['ids']));
    case 'setSort': return idStr(x['groupId']) && isStr(x['mode']) && SORT_MODES.includes(x['mode']);
    case 'setHideNoEpg': return typeof x['value'] === 'boolean';
    case 'markWatched': return idStr(x['id']);
    default: return false;
  }
}

// ---------- normalisation ----------

function cleanIds(x: unknown, max = MAX_IDS): string[] {
  if (!Array.isArray(x)) return [];
  return dedupe(x.filter((v): v is string => isStr(v) && v.length > 0 && v.length <= MAX_ID_LEN).slice(0, max * 2)).slice(0, max);
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
