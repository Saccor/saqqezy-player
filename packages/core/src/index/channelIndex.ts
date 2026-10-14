import { GROUP_ALL, GROUP_FAV, GROUP_RECENT, RECENT_MAX } from '../constants.ts';
import { normalize } from '../text/normalize.ts';
import type { Channel, GroupInfo } from '../types.ts';

export interface UserFlags {
  favourites: string[];
  hidden: string[];
  /** Most recent first, at most RECENT_MAX. */
  recent?: string[];
}

export class ChannelIndex {
  private readonly byId = new Map<string, Channel>();
  private readonly allSorted: Channel[];
  private readonly groupOrder: string[] = [];
  private readonly groupMembers = new Map<string, Channel[]>();
  private readonly searchKeys = new Map<string, string>();
  private favourites: string[];
  private hidden: Set<string>;
  private recent: string[];
  private visibleCache = new Map<string, Channel[]>();

  constructor(channels: Channel[], flags: UserFlags = { favourites: [], hidden: [] }) {
    for (const c of channels) {
      this.byId.set(c.id, c);
      this.searchKeys.set(c.id, normalize(c.name));
      const gid = `g:${c.group}`;
      let members = this.groupMembers.get(gid);
      if (!members) {
        members = [];
        this.groupMembers.set(gid, members);
        this.groupOrder.push(gid);
      }
      members.push(c);
    }
    this.allSorted = [...channels].sort((a, b) => a.number - b.number);
    // Raw lists are kept (including ids absent from this playlist) so a partial or broken
    // refresh cannot erase the user's choices; they are filtered only when read.
    this.favourites = [...flags.favourites];
    this.hidden = new Set(flags.hidden);
    this.recent = [...(flags.recent ?? [])].slice(0, RECENT_MAX);
  }

  private visible(groupId: string): Channel[] {
    const cached = this.visibleCache.get(groupId);
    if (cached) return cached;
    let source: Channel[];
    if (groupId === GROUP_ALL) source = this.allSorted;
    else if (groupId === GROUP_FAV) source = this.resolve(this.favourites);
    else if (groupId === GROUP_RECENT) source = this.resolve(this.recent);
    else source = this.groupMembers.get(groupId) ?? [];
    const list = source.filter((c) => !this.hidden.has(c.id));
    this.visibleCache.set(groupId, list);
    return list;
  }

  private resolve(ids: string[]): Channel[] {
    const out: Channel[] = [];
    for (const id of ids) {
      const c = this.byId.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  private invalidate(): void {
    this.visibleCache = new Map();
  }

  groups(): GroupInfo[] {
    const out: GroupInfo[] = [{ id: GROUP_FAV, name: 'Favourites', count: this.visible(GROUP_FAV).length }];
    const recentCount = this.visible(GROUP_RECENT).length;
    if (recentCount > 0) out.push({ id: GROUP_RECENT, name: 'Recently watched', count: recentCount });
    out.push({ id: GROUP_ALL, name: 'All channels', count: this.visible(GROUP_ALL).length });
    for (const gid of this.groupOrder) {
      const count = this.visible(gid).length;
      if (count > 0) out.push({ id: gid, name: gid.slice(2), count });
    }
    return out;
  }

  groupSize(groupId: string): number {
    return this.visible(groupId).length;
  }

  slice(groupId: string, offset: number, count: number): Channel[] {
    return this.visible(groupId).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, count));
  }

  indexOf(groupId: string, channelId: string): number {
    return this.visible(groupId).findIndex((c) => c.id === channelId);
  }

  get(id: string): Channel | undefined {
    return this.byId.get(id);
  }

  byNumber(n: number): Channel | undefined {
    return this.visible(GROUP_ALL).find((c) => c.number === n);
  }

  neighbour(groupId: string, channelId: string, delta: number): Channel | undefined {
    const list = this.visible(groupId);
    const i = list.findIndex((c) => c.id === channelId);
    if (i === -1 || list.length === 0) return undefined;
    const j = (((i + delta) % list.length) + list.length) % list.length;
    return list[j];
  }

  search(query: string, limit: number): Channel[] {
    const q = normalize(query);
    if (!q) return [];
    const prefix: Channel[] = [];
    const contains: Channel[] = [];
    for (const c of this.visible(GROUP_ALL)) {
      const key = this.searchKeys.get(c.id)!;
      if (key.startsWith(q)) prefix.push(c);
      else if (key.includes(q)) contains.push(c);
      if (prefix.length >= limit) break;
    }
    return [...prefix, ...contains].slice(0, limit);
  }

  setFavourite(id: string, on: boolean): void {
    if (!this.byId.has(id)) return;
    const has = this.favourites.includes(id);
    if (on && !has) this.favourites.push(id);
    if (!on && has) this.favourites = this.favourites.filter((f) => f !== id);
    this.invalidate();
  }

  setHidden(id: string, on: boolean): void {
    if (!this.byId.has(id)) return;
    if (on) this.hidden.add(id);
    else this.hidden.delete(id);
    this.invalidate();
  }

  markWatched(id: string): void {
    if (!this.byId.has(id)) return;
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
    this.invalidate();
  }

  hiddenChannels(): Channel[] {
    return this.allSorted.filter((c) => this.hidden.has(c.id));
  }

  flags(): UserFlags {
    return { favourites: [...this.favourites], hidden: [...this.hidden], recent: [...this.recent] };
  }
}
