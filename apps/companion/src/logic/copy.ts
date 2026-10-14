/** User-facing copy for connection outcomes. Neutral English; never echoes secrets or server details. */
export const COPY = {
  expired: 'This code has expired. Show a new code on your TV.',
  replaced: 'This session was opened somewhere else.',
  peerErrors: 'Connection problem – pair again.',
  unreachable: "Can't reach the TV. Check that the TV is on and showing the code.",
  busy: 'The TV is busy. Try again.',
  tvEnded: 'The TV closed this session. Show a new code on your TV to connect again.',
  genericError: 'Something went wrong. Try again.',
  timeout: 'The TV did not answer. Try again.',
  insecure: 'This page must be opened over a secure connection (https). Open the address shown on your TV.',
} as const;

/**
 * Why a session ended, as copy. Reasons are the transport's final close reasons (`expired` = relay 4000,
 * `replaced` = 4001, …), the channel's (`peer-errors`, `msgid-exhausted`) and the client's own
 * (`no-welcome`: no answer from the TV within 10 s; `tv-bye`: the TV said bye).
 */
export function endCopy(reason: string): string {
  switch (reason) {
    case 'expired':
    case 'no-welcome':
    case 'deadline':
      return COPY.expired;
    case 'replaced':
      return COPY.replaced;
    case 'unreachable':
      return COPY.unreachable;
    case 'tv-bye':
      return COPY.tvEnded;
    default:
      return COPY.peerErrors;
  }
}

/** A failed `result` as copy: Busy gets the busy copy, anything else the TV's (credential-free) message. */
export function resultErrorCopy(error: { name: string; message: string } | undefined): string {
  if (!error) return COPY.genericError;
  if (error.name === 'Busy') return COPY.busy;
  return error.message.trim() || COPY.genericError;
}
