export interface BudgetRule { max: number; windowMs: number }

/** At most 6 reconnects per minute and 20 per ten minutes: a long session never runs out, a dead source does. */
export const DEFAULT_BUDGET: readonly BudgetRule[] = [{ max: 6, windowMs: 60_000 }, { max: 20, windowMs: 600_000 }];

/** Rolling-window limiter: `tryTake()` succeeds only while every rule has room, and records nothing when it fails. */
export class ReconnectBudget {
  private stamps: number[] = [];

  constructor(private readonly rules: readonly BudgetRule[], private readonly now: () => number) {}

  tryTake(): boolean {
    const t = this.now();
    const longest = Math.max(0, ...this.rules.map((r) => r.windowMs));
    this.stamps = this.stamps.filter((s) => t - s < longest);
    for (const r of this.rules) {
      if (this.stamps.filter((s) => t - s < r.windowMs).length >= r.max) return false;
    }
    this.stamps.push(t);
    return true;
  }

  reset(): void {
    this.stamps = [];
  }
}
