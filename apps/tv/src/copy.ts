/**
 * UI copy that several screens share, so it is spelled one way everywhere (Home said "Favourites", the Player and the
 * VOD screens "favourites", and two different toasts covered a failed change). Pure: no Solid, no Lightning.
 */

/** The favourites strings: the menu labels, the detail button, and the toasts after a change. */
export const FAV_COPY = {
  add: 'Add to favourites',
  remove: 'Remove from favourites',
  in: 'In favourites',
  added: 'Added to favourites',
  removed: 'Removed from favourites',
  failed: "Couldn't change favourites.",
} as const;

/** The menu label for a channel or title: what pressing it does. */
export const favToggleLabel = (isFavourite: boolean): string => (isFavourite ? FAV_COPY.remove : FAV_COPY.add);
/** The toast after a change: what is now true. */
export const favChangedToast = (isFavourite: boolean): string => (isFavourite ? FAV_COPY.added : FAV_COPY.removed);

/** Live TV's channel menu, opened by OK: its play items above the programme and channel items. */
export const LIVE_MENU_COPY = { watch: 'Watch', preview: 'Preview' } as const;

/**
 * Catch-up strings (spec 2026-10-20-catch-up §5): neutral wording only (CLAUDE.md rule 3), no source or provider
 * names, nothing that suggests free content.
 */
export const CATCHUP_COPY = {
  fromStart: 'From the start',
  fromStartAvailable: 'From the start available',
  watchLive: 'Watch live',
  notAvailable: 'Not available. Your source did not return this programme.',
  noArchive: 'Not available on this channel',
  goToDay: 'Go to day',
  time: 'Catch-up time',
  timeHelp: 'Correct this if catch-up starts at the wrong time.',
  auto: 'Auto',
  daysLeft: (n: number): string => (n < 1 ? 'Catch-up · Last day' : `Catch-up · ${n} ${n === 1 ? 'day' : 'days'} left`),
  tooOld: (days: number): string => `Not available: older than ${days} ${days === 1 ? 'day' : 'days'}`,
  nextTitle: (title: string): string => `Next: ${title}`,
} as const;

/** Combined live channels (spec 2026-10-20-live-sources-tv): generic wording, no source or provider names. */
export const SOURCE_COPY = {
  choose: 'Choose source',
  source: 'Source',
  switched: 'Switched to another source',
  loadFailed: "Couldn't load the sources.",
  setting: 'Combine duplicate channels',
  settingHelp: 'One row per channel. If a stream fails, the next one takes over.',
} as const;

/**
 * Multiview (spec 2026-10-20-multiview §4, owner decisions §12): a tile is a "window"; neutral wording only, no source
 * names. The source's reported connection count is information, never a limit the app enforces.
 */
export const MULTIVIEW_COPY = {
  entry: 'Multiview',
  addToMultiview: 'Add to multiview',
  addChannel: 'Add channel',
  changeChannel: 'Change channel',
  fullScreen: 'Full screen',
  makeLarge: 'Make large',
  equalSize: 'Equal size',
  keepSound: 'Keep sound here',
  soundFollows: 'Sound follows focus',
  closeWindow: 'Close window',
  retry: 'Retry',
  starting: 'Starting…',
  freeing: 'Freeing a connection…',
  onScreen: 'On screen',
  infoUnknown: 'Each window uses one connection from your source.',
  escalated: 'Your source refused extra streams several times. Try again in a few minutes.',
  infoReported: (n: number): string => `Your source reports ${n} ${n === 1 ? 'connection' : 'connections'}. Each window uses one.`,
  kicked: (k: number): string => `Your source seems to allow ${k} ${k === 1 ? 'stream' : 'streams'} at once.`,
  learned: (k: number): string => `Last time your source refused window ${k}.`,
  device: (n: number): string => `This device can play ${n} at once.`,
  setting: (n: number): string => `Max windows is set to ${n} in Settings.`,
} as const;
