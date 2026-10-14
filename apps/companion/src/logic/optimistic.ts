import { applyOps, type Layout, type LayoutOp } from '@iptv/core';

interface Pending {
  id: number;
  ops: LayoutOp[];
  /** The TV answered ok; kept until the next TV layout (which then includes it). */
  acked: boolean;
}

/**
 * The companion's layout: the TV's last layout (`base`) with the changes still on their way applied on top, using
 * the same `applyOps` the TV runs. The TV wins: every TV layout replaces the base, acknowledged changes are then
 * dropped (the TV layout contains them, or overruled them), and only changes still unanswered are re-applied.
 * Every op is an intent with absolute targets (ids, absolute indices), so re-applying one the TV already has is
 * harmless. A TV layout older than the held one is ignored (a newer `layoutChanged` overtook it).
 */
export class OptimisticLayout {
  private confirmed: Layout | undefined;
  private pending: Pending[] = [];
  private nextId = 1;
  private cached: Layout | undefined;

  /** The TV's layout as last received. */
  base(): Layout | undefined {
    return this.confirmed;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** A layout from the TV (`state` or `layoutChanged`). False when it is older than the one held (ignored). */
  confirm(layout: Layout): boolean {
    if (this.confirmed && layout.version < this.confirmed.version) return false;
    this.confirmed = layout;
    this.pending = this.pending.filter((p) => !p.acked);
    this.cached = undefined;
    return true;
  }

  /** Applies a change locally until the TV answers. Returns its handle for `ack` / `drop`. */
  add(ops: LayoutOp[]): number {
    const id = this.nextId++;
    this.pending.push({ id, ops, acked: false });
    this.cached = undefined;
    return id;
  }

  /** The TV applied it: it stays in the view until the next TV layout arrives. */
  ack(id: number): void {
    const p = this.pending.find((x) => x.id === id);
    if (p) p.acked = true;
  }

  /** Forgets a change: the TV rejected it, or it was acknowledged and no layout followed (nothing changed). */
  drop(id: number): void {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => p.id !== id);
    if (this.pending.length !== before) this.cached = undefined;
  }

  /** Reasons the reducer would reject `ops` on the current view (empty: fine to send). */
  check(ops: LayoutOp[]): string[] {
    const v = this.view();
    if (!v) return ['no layout'];
    return applyOps(v, ops).rejected.map((r) => r.reason);
  }

  /** What the user sees: the TV layout plus the changes still on their way. */
  view(): Layout | undefined {
    if (!this.confirmed) return undefined;
    if (!this.cached) {
      this.cached = this.pending.length === 0
        ? this.confirmed
        : applyOps(this.confirmed, this.pending.flatMap((p) => p.ops)).layout;
    }
    return this.cached;
  }

  reset(): void {
    this.confirmed = undefined;
    this.pending = [];
    this.cached = undefined;
  }
}
