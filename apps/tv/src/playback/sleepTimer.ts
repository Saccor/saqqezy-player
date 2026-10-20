/** Sleep timer choices in minutes; 0 is Off. */
export const SLEEP_OPTIONS = [0, 15, 30, 60, 90, 120] as const;

export type SleepState =
  | { kind: 'off' }
  | { kind: 'armed'; minutes: number; endsAt: number }
  | { kind: 'asking'; secondsLeft: number };

export interface SleepTimer {
  /** Starts (or replaces) the timer; 0 turns it off. */
  set(minutes: number): void;
  /** Answer to "Still watching?": turns the timer off. */
  stillWatching(): void;
  state(): SleepState;
  /** Whole minutes left while armed (rounded up). */
  minutesLeft(): number | undefined;
  dispose(): void;
}

/** The option after `minutes` in `SLEEP_OPTIONS` (wrapping to Off; unknown values go to Off). */
export function nextSleepOption(minutes: number): number {
  const i = SLEEP_OPTIONS.indexOf(minutes as (typeof SLEEP_OPTIONS)[number]);
  if (i === -1) return 0;
  return SLEEP_OPTIONS[(i + 1) % SLEEP_OPTIONS.length]!;
}

/**
 * off → armed (set) → asking (time is up: a `askSeconds` countdown) → off, calling `onExpire` when the
 * countdown reaches 0 without `stillWatching()`.
 */
export function createSleepTimer(opts: {
  onChange(s: SleepState): void;
  onExpire(): void;
  askSeconds?: number;
  now?: () => number;
}): SleepTimer {
  const askSeconds = opts.askSeconds ?? 60;
  const now = opts.now ?? (() => Date.now());
  let state: SleepState = { kind: 'off' };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const clear = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (interval !== undefined) clearInterval(interval);
    timeout = undefined;
    interval = undefined;
  };
  const go = (s: SleepState) => {
    state = s;
    if (!disposed) opts.onChange(s);
  };
  const ask = () => {
    clear();
    go({ kind: 'asking', secondsLeft: askSeconds });
    interval = setInterval(() => {
      if (state.kind !== 'asking') return;
      const left = state.secondsLeft - 1;
      if (left > 0) return go({ kind: 'asking', secondsLeft: left });
      clear();
      go({ kind: 'off' });
      opts.onExpire();
    }, 1000);
  };

  return {
    set(minutes) {
      if (disposed) return;
      clear();
      if (minutes <= 0) return go({ kind: 'off' });
      const ms = minutes * 60_000;
      go({ kind: 'armed', minutes, endsAt: now() + ms });
      timeout = setTimeout(ask, ms);
    },
    stillWatching() {
      if (disposed) return;
      clear();
      go({ kind: 'off' });
    },
    state: () => state,
    minutesLeft: () => (state.kind === 'armed' ? Math.ceil((state.endsAt - now()) / 60_000) : undefined),
    dispose() {
      clear();
      disposed = true;
    },
  };
}

/** What a Player attaches to the shared timer: its state changes and the expiry it answers with a stop. */
export interface SleepListener { onChange(s: SleepState): void; onExpire(): void }

export interface SharedSleepTimer extends Omit<SleepTimer, 'dispose'> {
  /**
   * True after the user turned the timer off (`set(0)`) until it is armed again: a Player that remounts (back from
   * the Guide) must not re-arm the Settings default over an explicit Off.
   */
  userOff(): boolean;
  /**
   * The Player on screen: it sees every change from now on, and the current state at once when the timer is not
   * off (an armed timer shows its minutes; an open question reopens its dialog). Returns the detach; a later attach
   * replaces an earlier one.
   */
  attach(l: SleepListener): () => void;
}

/**
 * One sleep timer for the app (like `channelHistory`): it survives Player remounts, so a trip to the Guide or Home
 * no longer resets it. Only one Player is ever attached. An expiry with no Player attached (the user left for Home
 * or Start and the question had nobody to answer it) runs `onExpireUnattended`: the app's instance stops playback.
 */
export function createSharedSleepTimer(opts: { onExpireUnattended?(): void; askSeconds?: number; now?: () => number } = {}): SharedSleepTimer {
  let listener: SleepListener | undefined;
  let userOff = false;
  const inner = createSleepTimer({
    onChange: (s) => listener?.onChange(s),
    onExpire: () => (listener ? listener.onExpire() : opts.onExpireUnattended?.()),
    ...(opts.askSeconds !== undefined ? { askSeconds: opts.askSeconds } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    set: (minutes) => { userOff = minutes <= 0; inner.set(minutes); },
    stillWatching: () => inner.stillWatching(),
    userOff: () => userOff,
    state: () => inner.state(),
    minutesLeft: () => inner.minutesLeft(),
    attach(l) {
      listener = l;
      const s = inner.state();
      if (s.kind !== 'off') l.onChange(s);
      return () => { if (listener === l) listener = undefined; };
    },
  };
}
