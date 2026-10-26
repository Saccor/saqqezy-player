/** App-level copy: shell notices, the start-up error and worker event toasts. */
export const SHELL_COPY = {
  offline: 'Offline · saved list',
  phone: 'Phone connected',
  exit: 'Exit the app?',
  /** Yellow reveals a password until phase 2 (named copy exceptions). */
  revealShow: 'Yellow: show password',
  revealHide: 'Yellow: hide password',
  initError: {
    title: "Couldn't load your saved data",
    body: 'Your sources are still saved on this device. Try again.',
  },
  events: {
    fromPhone: 'Updated from your phone',
    refreshChannels: "Couldn't refresh channels. Showing saved list.",
    refreshGuide: "Couldn't refresh the TV guide.",
  },
} as const;
