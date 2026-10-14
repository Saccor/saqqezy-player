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
  /** A source request got no sign of life for 60 s; it keeps going in the background. */
  stillWorking: 'The TV is still working or not answering. Check the TV.',
  /** A source whose request is still running on the TV (the form was closed, or it stalled). */
  rowWorking: 'Still working on the TV…',
  /** getState went unanswered after its retries (also after a reconnect or a resume). */
  notAnswering: "The TV isn't answering.",
  /** The QR link's fragment could not be read. */
  invalidLink: 'This link is not valid. Show a new code on your TV, or type the code below.',
  /** The page was hidden or restored from the back/forward cache: that session is over. */
  sessionEnded: 'This session ended. Show a new code on your TV.',
  /** A layout change the reducer refuses (e.g. too many lists, a name that is too long). */
  opRejected: 'That change could not be made.',
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
