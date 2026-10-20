import { EPG_AHEAD_MS, EPG_BACK_MS } from '../constants.ts';
import { normalize } from '../text/normalize.ts';
import type { Channel, Programme } from '../types.ts';

export function epgKey(c: Channel): string {
  return c.epgId ?? `name:${normalize(c.name)}`;
}

export function applyShift(p: Programme, hours: number): Programme {
  const ms = hours * 3600_000;
  return { ...p, start: p.start + ms, stop: p.stop + ms };
}

/** `backMs`: how far back to keep this programme's channel (catch-up channels keep their archive days; at least 6 h). */
export function inWindow(p: Programme, now: number, backMs = EPG_BACK_MS): boolean {
  return p.stop > now - Math.max(backMs, EPG_BACK_MS) && p.start < now + EPG_AHEAD_MS;
}

export function nowNext(programmes: Programme[], now: number): { now?: Programme; next?: Programme } {
  let current: Programme | undefined;
  let next: Programme | undefined;
  for (const p of programmes) {
    if (p.start <= now && p.stop > now) current = p;
    else if (p.start > now && (!next || p.start < next.start)) next = p;
  }
  const out: { now?: Programme; next?: Programme } = {};
  if (current) out.now = current;
  if (next) out.next = next;
  return out;
}

export class EpgMatcher {
  private readonly epgIds = new Set<string>();
  private readonly byName = new Map<string, string>();
  private readonly resolved = new Map<string, string>();

  constructor(channels: Channel[]) {
    for (const c of channels) {
      if (c.epgId) this.epgIds.add(c.epgId);
      const name = normalize(c.name);
      if (name && !this.byName.has(name)) this.byName.set(name, epgKey(c));
    }
  }

  addXmltvChannel(id: string, names: string[]): void {
    if (this.epgIds.has(id)) {
      this.resolved.set(id, id);
      return;
    }
    for (const n of names) {
      const key = this.byName.get(normalize(n));
      if (key) {
        this.resolved.set(id, key);
        return;
      }
    }
  }

  resolve(xmltvChannelId: string): string | undefined {
    return this.resolved.get(xmltvChannelId) ?? (this.epgIds.has(xmltvChannelId) ? xmltvChannelId : undefined);
  }
}
