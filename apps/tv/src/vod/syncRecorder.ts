import type { TrackInfo } from '@iptv/player';
import { englishLanguageName } from '@iptv/core';

/**
 * Automatic subtitle sync, the player's half (spec 2026-10-21 §4): while a loaded file shows, the stream's own track
 * plays unseen and this records when it had a line on screen, in video time, plus the spans played without a seek.
 * The worker lines the file up against that (`api.syncSubtitle`).
 */

/** Sampling stops after this much played video without a clear answer. */
export const SYNC_GIVE_UP_PLAYED_MS = 15 * 60_000;
/** A playhead step larger than this (or backwards) is a seek: a new span starts. */
const MAX_STEP_MS = 3000;

/** The span shape the worker takes (`SyncSample`), kept local so core stays out of the UI bundle. */
export interface RecordedSample { cues: [number, number][]; played: [number, number][] }

export class SyncRecorder {
  private readonly cues: [number, number][] = [];
  private readonly spans: [number, number][] = [];
  private span: [number, number] | undefined;
  private open: number | undefined;
  private lastPos: number | undefined;

  /** Each player tick: the playhead and whether it is playing. */
  tick(posMs: number, playing: boolean): void {
    if (!playing) {
      this.closeSpan();
      return;
    }
    const last = this.lastPos;
    if (this.span && last !== undefined && posMs >= last && posMs - last <= MAX_STEP_MS) {
      this.span[1] = posMs;
    } else {
      this.closeSpan();
      this.span = [posMs, posMs];
    }
    this.lastPos = posMs;
  }

  /** The stream's track changed its line at the playhead: `on` a line shows (a new one ends the one before). */
  cue(on: boolean, posMs: number): void {
    if (this.open !== undefined && posMs > this.open) this.cues.push([this.open, posMs]);
    this.open = on ? posMs : undefined;
  }

  sample(): RecordedSample {
    const played = this.span && this.span[1] > this.span[0] ? [...this.spans, [...this.span] as [number, number]] : [...this.spans];
    return { cues: this.cues.map((c) => [...c] as [number, number]), played };
  }

  playedMs(): number {
    return this.sample().played.reduce((n, [a, b]) => n + (b - a), 0);
  }

  /** Enough video played without a clear answer: stop listening. */
  exhausted(): boolean {
    return this.playedMs() >= SYNC_GIVE_UP_PLAYED_MS;
  }

  private closeSpan(): void {
    if (this.span && this.span[1] > this.span[0]) this.spans.push(this.span);
    this.span = undefined;
    this.lastPos = undefined;
    // A line open across a pause or seek has no trustworthy end.
    this.open = undefined;
  }
}

const isForced = (t: TrackInfo) => t.forced === true || /\bforced\b/i.test(t.label);

/**
 * The stream's track to listen to: one in the loaded file's language (`lang`, ISO 639-1) when there is one, else the
 * first full track. Forced tracks only cover a few lines, so they are never used.
 */
export function syncReferenceTrack(tracks: readonly TrackInfo[], lang: string | undefined): TrackInfo | undefined {
  const full = tracks.filter((t) => !isForced(t));
  const want = lang ? englishLanguageName(lang) : undefined;
  return (want ? full.find((t) => t.language !== undefined && englishLanguageName(t.language) === want) : undefined) ?? full[0];
}
