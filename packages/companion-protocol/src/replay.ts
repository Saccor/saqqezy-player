/**
 * Remembers the last `size` accepted msgIds (default 1024) for one direction and rejects repeats.
 * When full, the oldest accepted msgId is forgotten. A rejected duplicate does not refresh its position.
 */
export class ReplayWindow {
  private readonly seen = new Set<number>();
  private readonly size: number;

  constructor(size = 1024) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
    this.size = size;
  }

  accept(msgId: number): boolean {
    if (this.seen.has(msgId)) return false;
    this.seen.add(msgId);
    if (this.seen.size > this.size) {
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }
}
