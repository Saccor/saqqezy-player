/**
 * The minimum gap between stream opens on one source, shared by every supervisor that plays from it (multiview tiles).
 * Each supervisor keeps its own gap as before; this adds the gap after the latest open of any OTHER supervisor, so
 * tiles started together open about 1.15 s apart and a single supervisor behaves exactly as without it. Keys are
 * source ids; nothing else is held.
 */
export class SharedOpenGap {
  /** Per source: per owner, the time until which its latest open keeps others waiting. */
  private readonly until = new Map<string, Map<number, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Ms until `owner` may open on `key`: 0 when no other owner opened within its drawn gap. */
  waitMs(key: string, owner: number): number {
    const t = this.now();
    let wait = 0;
    for (const [o, u] of this.until.get(key) ?? []) if (o !== owner) wait = Math.max(wait, u - t);
    return Math.max(0, Math.ceil(wait));
  }

  /** `owner` opened (or probed) on `key` now; others wait `gapMs`. */
  mark(key: string, owner: number, gapMs: number): void {
    const t = this.now();
    let owners = this.until.get(key);
    if (!owners) this.until.set(key, (owners = new Map()));
    owners.set(owner, t + gapMs);
    for (const [o, u] of owners) if (u <= t && o !== owner) owners.delete(o);
  }
}
