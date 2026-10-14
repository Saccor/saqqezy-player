/**
 * Channel zapping with a debounced commit. Every press resolves the target right away (so the banner can show
 * it immediately) as `anchor + accumulated offset`, where the anchor is the last committed channel; only the
 * answer to the latest press counts, so slow out-of-order lookups cannot win. The commit (the actual stream
 * switch) runs once nothing was pressed for `delayMs`, or as soon as the latest answer arrives if that is later.
 */
export interface Zapper {
  /** The channel that is playing now; drops any burst in progress. */
  setCurrent(id: string): void;
  press(delta: number): void;
  cancel(): void;
}

export interface ZapperOptions<T extends { id: string }> {
  delayMs: number;
  resolve(anchorId: string, offset: number): Promise<T | undefined>;
  onPreview(target: T): void;
  onCommit(target: T): void;
  /** The latest press resolved to nothing (or failed); the burst is dropped. */
  onMiss?(): void;
}

export function createZapper<T extends { id: string }>(opts: ZapperOptions<T>): Zapper {
  let anchor: string | undefined;
  let offset = 0;
  let seq = 0;
  let target: T | undefined;
  let elapsed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reset = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    seq++;
    offset = 0;
    target = undefined;
    elapsed = false;
  };
  const commit = (t: T) => {
    reset();
    anchor = t.id;
    opts.onCommit(t);
  };
  const miss = () => {
    reset();
    opts.onMiss?.();
  };

  return {
    setCurrent(id) {
      reset();
      anchor = id;
    },
    press(delta) {
      if (anchor === undefined) return;
      offset += delta;
      const mine = ++seq;
      target = undefined;
      elapsed = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (mine !== seq) return;
        if (target) commit(target);
        else elapsed = true;
      }, opts.delayMs);
      opts.resolve(anchor, offset).then(
        (t) => {
          if (mine !== seq) return;
          if (!t) return miss();
          target = t;
          opts.onPreview(t);
          if (elapsed) commit(t);
        },
        () => { if (mine === seq) miss(); },
      );
    },
    cancel: reset,
  };
}
