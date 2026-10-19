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
