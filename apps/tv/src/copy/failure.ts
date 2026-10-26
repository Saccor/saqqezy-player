/**
 * The five failure messages (spec 2026-10-26 §1.4) and the cooldown lines. Neutral: never a provider's name, nothing
 * about free content (CLAUDE.md rules 2, 3). Each ends with one full stop before which a status can go ("(403)").
 */
export const FAILURE_COPY = {
  unreachable: "Couldn't reach the source.",
  refused: 'The source refused this stream.',
  noPicture: "No picture: this TV can't play this video format.",
  noSound: "No sound: this audio format can't play here.",
  noSoundTryTrack: "No sound: this audio format can't play here. Try another track.",
  tryAnother: 'Gone from the source. Try another source.',
  allows: (n: number): string => `It allows ${n} ${n === 1 ? 'connection' : 'connections'}.`,
} as const;

/** The refusal cooldown (spec 2026-10-16-source-retry §2.4), as a Notice of kind error with a "Try again" action. */
export const COOLDOWN_COPY = {
  refused: "The source refused. Waiting so you don't get blocked.",
  unreachable: "Couldn't reach the source. Waiting before trying again.",
  tryingAgainIn: (minutes: number): string => `Trying again in ${minutes} min`,
} as const;
