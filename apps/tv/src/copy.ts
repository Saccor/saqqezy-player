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
