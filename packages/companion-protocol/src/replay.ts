/**
 * Replay protection for one direction. Remembers the last `size` accepted msgIds (default 1024) and rejects
 * repeats. When full, the oldest accepted msgId is forgotten, and a low-water mark is raised to the largest
 * msgId evicted so far: from then on every msgId <= that mark is rejected, even one never seen. A rejected
 * msgId does not refresh its position.
 *
 * Requirements on the sender (SecureChannel meets them):
 * - msgIds increase monotonically for the lifetime of the pairing and never wrap or reset, including across
 *   transport reconnects. A sender that restarted its counter would have its messages silently rejected.
 * - The window is fed once per completed message, not per frame (see Reassembler).
 */
export class ReplayWindow {
  private readonly seen = new Set<number>();
  private readonly size: number;
  /** Largest evicted msgId; -1 until the first eviction. */
  private lowWater = -1;

  constructor(size = 1024) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
    this.size = size;
  }

  accept(msgId: number): boolean {
    if (!Number.isInteger(msgId) || msgId < 0 || msgId > 0xffffffff) return false;
    if (msgId <= this.lowWater || this.seen.has(msgId)) return false;
    this.seen.add(msgId);
    if (this.seen.size > this.size) {
      const oldest = this.seen.values().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
        if (oldest.value > this.lowWater) this.lowWater = oldest.value;
      }
    }
    return true;
  }
}
