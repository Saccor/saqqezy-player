/**
 * Live TV's "no sound" note: the picture plays but the device decodes none of the sound (desktop Chrome has no
 * AC-3 / E-AC-3, common on UHD channels). Movies say the same in VodPlay; live says it once per channel per session.
 */
import { FAILURE_COPY } from '../copy.ts';

/** The same two failure messages as movies (spec 2026-10-26 §1.4: one wording per failure). */
export function liveNoSoundText(audioTrackCount: number): string {
  return audioTrackCount > 1 ? FAILURE_COPY.noSoundTryTrack : FAILURE_COPY.noSound;
}

export interface LiveSoundDeps {
  /** The live channel playing now, undefined when none (or a movie) plays. */
  channelId(): string | undefined;
  /** True when that channel's picture plays without decodable sound (`liveSoundUndecodable`). */
  soundUndecodable(): boolean;
  audioTrackCount(): number;
  toast(text: string): void;
}

/** Call `tick` about once a second; a silent channel is told once, however often it is tuned again. */
export function createLiveSoundWatch(d: LiveSoundDeps): { tick(): void } {
  const told = new Set<string>();
  return {
    tick() {
      const id = d.channelId();
      if (id === undefined || told.has(id) || !d.soundUndecodable()) return;
      told.add(id);
      d.toast(liveNoSoundText(d.audioTrackCount()));
    },
  };
}
