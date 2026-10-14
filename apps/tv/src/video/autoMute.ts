/**
 * Desktop autoplay policy: without a user gesture only muted playback may start, so the player mutes and
 * retries. This remembers that the mute was ours, so the first user gesture (or an already activated page)
 * gives the sound back without overriding a mute someone else set.
 */
export class AutoMute {
  private auto = false;

  constructor(private readonly media: { muted: boolean }) {}

  get active(): boolean {
    return this.auto;
  }

  /** Mutes for an autoplay retry. Returns false when the element was already muted (nothing to retry). */
  mute(): boolean {
    if (this.media.muted) return false;
    this.media.muted = true;
    this.auto = true;
    return true;
  }

  /** Unmutes if (and only if) the current mute is ours. */
  release(): void {
    if (!this.auto) return;
    this.auto = false;
    this.media.muted = false;
  }

  /** `navigator.userActivation`: once the page has had a gesture, sound may play, so drop our mute. */
  releaseIfActivated(activation: { hasBeenActive: boolean } | undefined): void {
    if (activation?.hasBeenActive) this.release();
  }
}
