import type { EngineName, ErrorCode, LivePreset } from './types.ts';

export type ReconnectReason = 'noBytes' | 'emptyBuffer' | 'frozenVideo' | 'backstop';
export type ReconnectCause = ErrorCode | ReconnectReason | 'startTimeout' | 'drift' | 'goLive' | 'edgeSeekFailed' | 'seek';

/** One thing the player did. Never a URL or credentials (CLAUDE.md rules 6-7); `t` is clock ms (Date.now). */
export type JournalEvent =
  | { k: 'page'; t: number; what: 'load' | 'hidden' | 'visible'; nav?: 'navigate' | 'reload' | 'back_forward' | 'prerender' }
  | { k: 'play'; t: number; channel?: string; preset: LivePreset; urls: number }
  | { k: 'open'; t: number; attempt: number; urlIndex: number }
  | { k: 'playing'; t: number; attempt: number; firstFrameMs?: number; engine?: EngineName }
  | { k: 'stall'; t: number; phase: 'start'; bufferAheadS?: number }
  | { k: 'stall'; t: number; phase: 'end'; durationMs: number }
  | { k: 'ladder'; t: number; action: 'gapJump' | 'seekLive' | 'reconnect'; reason?: ReconnectReason; bufferAheadS?: number }
  | { k: 'error'; t: number; code: ErrorCode | 'UNKNOWN'; httpStatus?: number; detail?: string; engine?: EngineName }
  | { k: 'reconnect'; t: number; delayMs: number; cause: ReconnectCause }
  | { k: 'alternate'; t: number; urlIndex: number }
  /** The source had no room for another open (per-source open rate): the open waits `delayMs`. */
  | { k: 'rateWait'; t: number; delayMs: number }
  | { k: 'drift'; t: number; action: 'seek' | 'reopen' | 'rate'; behindS?: number; targetS: number; rate?: number }
  | { k: 'failed'; t: number; reason: 'unavailable' | 'unsupported' | 'refused' | 'gone' }
  | { k: 'giveUpRetry'; t: number }
  | { k: 'stop'; t: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A journal event before its time stamp is added. */
export type JournalInput = DistributiveOmit<JournalEvent, 't'>;

export interface JournalSink { add(e: JournalEvent): void }
export interface JournalPersist { load(): string | null; save(json: string): void }

export interface JournalOptions {
  capacity?: number;
  persist?: JournalPersist;
  saveEveryMs?: number;
  now?: () => number;
}

const KINDS = new Set<string>([
  'page', 'play', 'open', 'playing', 'stall', 'ladder', 'error', 'reconnect', 'alternate', 'drift', 'failed', 'giveUpRetry', 'stop',
]);
const DETAIL_RE = /^[A-Za-z_]{1,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_.]{1,40}$/;
const CHANNEL_MAX = 60;
const VERSION = 1;

/**
 * A safe copy of `e`, or undefined when it is not a journal event: unknown kinds and bad times are dropped, the
 * channel name is trimmed, `detail` must be a plain error id (never free text that could hold a URL), and
 * undefined or non-finite fields are left out.
 */
export function sanitizeEvent(e: unknown): JournalEvent | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const src = e as Record<string, unknown>;
  if (typeof src.k !== 'string' || !KINDS.has(src.k) || typeof src.t !== 'number' || !Number.isFinite(src.t)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(src)) {
    if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) continue;
    if (key === 'channel') {
      const c = typeof v === 'string' ? v.trim().slice(0, CHANNEL_MAX) : '';
      if (c) out.channel = c;
      continue;
    }
    if (key === 'detail') {
      if (typeof v === 'string' && DETAIL_RE.test(v)) out.detail = v;
      continue;
    }
    // Every other field is a number, boolean or a short enum-like token; anything else could carry a URL.
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && TOKEN_RE.test(v))) out[key] = v;
  }
  return out as JournalEvent;
}

/**
 * What the player did, newest last, capped (default 200). Saved through `persist` shortly after a change (deferred, never inside `add`),
 * at most once per `saveEveryMs`; `flush()` saves anything pending (call it on pagehide). Storage failures are swallowed:
 * the journal then simply lives in memory.
 */
export class PlaybackJournal implements JournalSink {
  private events: JournalEvent[];
  private readonly capacity: number;
  private readonly persist: JournalPersist | undefined;
  private readonly saveEveryMs: number;
  private readonly now: () => number;
  private dirty = false;
  private timerPending = false;
  private lastSaveAt = Number.NEGATIVE_INFINITY;

  constructor(opts: JournalOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 200);
    this.persist = opts.persist;
    this.saveEveryMs = opts.saveEveryMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.events = this.load();
  }

  add(e: JournalEvent): void {
    const s = sanitizeEvent(e);
    if (!s) return;
    this.events.push(s);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.dirty = true;
    this.scheduleSave();
  }

  entries(): JournalEvent[] {
    return this.events.slice();
  }

  clear(): void {
    this.events = [];
    this.dirty = true;
    this.save();
  }

  flush(): void {
    if (this.dirty) this.save();
  }

  private scheduleSave(): void {
    if (!this.persist || this.timerPending) return;
    // Clamped so a backward clock step cannot stall saves; never saved inside add() (keeps JSON + setItem off the zap path).
    const wait = Math.min(this.saveEveryMs, this.lastSaveAt + this.saveEveryMs - this.now());
    this.timerPending = true;
    globalThis.setTimeout(() => {
      this.timerPending = false;
      this.flush();
    }, Math.max(0, wait));
  }

  private save(): void {
    this.dirty = false;
    if (!this.persist) return;
    this.lastSaveAt = this.now();
    try {
      this.persist.save(JSON.stringify({ v: VERSION, e: this.events }));
    } catch {
      // quota or denied: the journal stays in memory
    }
  }

  private load(): JournalEvent[] {
    try {
      const raw = this.persist?.load();
      if (!raw) return [];
      const v = JSON.parse(raw) as { v?: unknown; e?: unknown } | null;
      if (!v || v.v !== VERSION || !Array.isArray(v.e)) return [];
      const out: JournalEvent[] = [];
      for (const item of v.e) {
        const s = sanitizeEvent(item);
        if (s) out.push(s);
      }
      return out.slice(-this.capacity);
    } catch {
      return [];
    }
  }
}
