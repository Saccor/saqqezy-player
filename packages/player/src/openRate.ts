import type { BudgetRule } from './reconnectBudget.ts';

/**
 * Stream opens per source, across every play(), reconnect, alternate and reload. A CDN in front of a panel blocked
 * a PC after about 12 connection attempts in a minute, before any refusal: every open counts, not only the ones
 * after a 403. 6 a minute still lets a viewer zap through channels; past that the next open waits for room.
 */
export const DEFAULT_OPEN_RATE: readonly BudgetRule[] = [{ max: 6, windowMs: 60_000 }, { max: 30, windowMs: 600_000 }];

/** Where the open times live between page loads (localStorage on the TV). Never holds URLs: source ids only. */
export interface OpenRateStore {
  load(): string | undefined | null;
  save(data: string): void;
}

export interface SourceOpenRateOptions {
  rules?: readonly BudgetRule[];
  now?: () => number;
  store?: OpenRateStore;
}

/** Rolling-window open limiter per source key. `waitMs` says how long until an open fits; `take` records one. */
export class SourceOpenRate {
  private readonly rules: readonly BudgetRule[];
  private readonly now: () => number;
  private readonly store: OpenRateStore | undefined;
  private readonly longest: number;
  private stamps: Map<string, number[]> | undefined;

  constructor(opts: SourceOpenRateOptions = {}) {
    this.rules = opts.rules ?? DEFAULT_OPEN_RATE;
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    this.longest = Math.max(0, ...this.rules.map((r) => r.windowMs));
  }

  waitMs(key: string): number {
    const t = this.now();
    const list = this.recent(key, t);
    let wait = 0;
    for (const r of this.rules) {
      const inWindow = list.filter((s) => t - s < r.windowMs);
      if (inWindow.length < r.max) continue;
      // The open that must leave the window first: the one `max` places from the newest.
      const leaving = inWindow[inWindow.length - r.max]!;
      wait = Math.max(wait, leaving + r.windowMs - t);
    }
    return wait;
  }

  take(key: string): void {
    const t = this.now();
    const all = this.all();
    all.set(key, [...this.recent(key, t), t]);
    for (const [k, list] of all) {
      const kept = list.filter((s) => t - s < this.longest);
      if (kept.length) all.set(k, kept);
      else all.delete(k);
    }
    try {
      this.store?.save(JSON.stringify(Object.fromEntries(all)));
    } catch {
      // Storage full or blocked: the limit still holds for this page.
    }
  }

  private recent(key: string, t: number): number[] {
    return (this.all().get(key) ?? []).filter((s) => t - s < this.longest).sort((a, b) => a - b);
  }

  private all(): Map<string, number[]> {
    if (!this.stamps) {
      this.stamps = new Map();
      try {
        const raw = this.store?.load();
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(v)) this.stamps.set(k, v.filter((x): x is number => typeof x === 'number'));
          }
        }
      } catch {
        // Unreadable: start empty.
      }
    }
    return this.stamps;
  }
}
