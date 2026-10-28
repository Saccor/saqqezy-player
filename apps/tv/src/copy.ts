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
  retry: 'Try again',
  watchInstead: 'Watch this one instead',
  stoppedForOther: 'Stopped so another window can play.',
  starting: 'Starting…',
  freeing: 'Freeing a connection…',
  onScreen: 'On screen',
  searchChannels: 'Search channels',
  noChannelsMatch: 'No channels match',
  limit: 'Each window uses one connection from your source.',
  /** Why "Add channel" is off (`canAddWindow`): the device, or the user's Max windows setting. */
  device: (n: number): string => `This device can play ${n} at once.`,
  setting: (n: number): string => `Max windows is set to ${n} in Settings.`,
  deviceLimit: 'This TV can show one channel at a time.',
  escalated: 'The source refused extra windows. Try again in a few minutes.',
} as const;

/**
 * Your countries (spec 2026-10-22-your-countries-flags, Copy table), word for word. Neutral (CLAUDE.md rule 3): no
 * channel, provider or broadcaster names, nothing about free content, no counts of channels or countries in store copy.
 */
export const COUNTRIES_COPY = {
  page: 'Your countries',
  thisTv: 'This TV',
  sortMost: 'Most folders first',
  sortAz: 'A–Z',
  languages: 'Languages',
  otherFolders: "Other countries' folders",
  fold: 'In one folder',
  below: 'Below yours',
  hidden: 'Hidden',
  reset: 'Show all folders as before',
  otherCountriesTitle: 'Other countries',
  countriesTitle: 'Countries',
  otherCountries: (n: number): string => `Other countries (${n})`,
  countries: (n: number): string => `Countries (${n})`,
  choose: 'Choose your countries…',
  otherHeading: 'Other folders',
  showing: (n: number): string => `Showing ${n} ${n === 1 ? 'country' : 'countries'} · Change`,
  cap: 'You can pick up to 10 countries.',
  stale: 'None of your countries are in this source. Showing all folders.',
  combineOff: 'Movie and series categories now stay per country.',
  combineOn: 'Not sorted by country while categories are combined.',
  none: "This source doesn't sort its folders by country.",
  loadError: "Couldn't load your countries · Try again",
  saveError: "Couldn't save the setting.",
  firstTitle: 'Which countries do you watch?',
  firstSub: (n: number): string => `Folders for ${n} countries found. Pick one or more.`,
  step: 'Last step',
  done: 'Done',
  skip: 'Skip',
  change: 'Change',
  languageLine: (name: string): string => `Audio and subtitles: ${name} first`,
  folders: (n: number): string => `${n} ${n === 1 ? 'folder' : 'folders'}`,
  selectedCount: (n: number): string => `✓ ${n}`,
  folderRow: (label: string, folders: string): string => `${label} · ${folders}`,
  resultLive: (folders: string): string => `Live TV: ${folders} first`,
  resultMovies: (n: number): string => `Movies: ${n}`,
  resultSeries: (n: number): string => `Series: ${n}`,
} as const;

/** A lazily loaded screen whose code could not be loaded (spec 2026-10-26, error handling). */
export const LAZY_COPY = { failed: "Couldn't open this screen.", retry: 'Try again' } as const;
export { COMMON_COPY } from './copy/common.ts';
export { COOLDOWN_COPY, FAILURE_COPY } from './copy/failure.ts';
export { SHELL_COPY } from './copy/shell.ts';
export { PLAYER_COPY } from './copy/player.ts';
export { VOD_COPY } from './copy/vod.ts';
export { TRENDING_COPY } from './copy/trending.ts';
export { LIVE_COPY } from './copy/live.ts';
export { SETTINGS_COPY } from './copy/settings.ts';
export { ONBOARDING_COPY } from './copy/onboarding.ts';
