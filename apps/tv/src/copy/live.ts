/** Live TV, guide, Start, Search and the channel menus' copy (spec 2026-10-26 §1.4). Neutral: no source, provider or broadcaster names. */
export const LIVE_COPY = {
  addTo: (name: string): string => `Add "${name}" to`,
  preview: 'Preview',
  noGuideInfo: 'No guide information',
  noInfo: 'No information',
  /** The channel menu (Home, Live TV, Start). */
  menu: {
    watch: 'Watch',
    preview: 'Preview',
    addToList: 'Add to list…',
    removeFromList: (name: string): string => `Remove from "${name}"`,
    showChannel: 'Show channel',
    hideChannel: 'Hide channel',
    chooseSource: 'Choose source…',
    rename: 'Rename…',
    newList: 'New list…',
  },
  /** List and channel editing. */
  lists: {
    tooLong: (max: number): string => `Use at most ${max} characters.`,
    enterName: 'Enter a name for the list.',
    emptyList: 'Empty – add channels from the channel menu',
    noChannels: 'No channels here yet.',
    newListName: 'New list name',
    newListValue: 'New list',
    channelName: 'Channel name (empty restores the original)',
    changeFailed: "Couldn't change this channel.",
    loadFailed: "Couldn't load your lists.",
    removedFrom: (name: string): string => `Removed from "${name}"`,
    removed: 'Removed from the list',
    hidden: 'Channel hidden',
    shown: 'Channel shown',
    restored: 'Original name restored',
    renamed: 'Channel renamed',
  },
  /** Home and Live TV states. */
  state: {
    noLive: 'This source has no live channels. Movies and series are in the menu.',
    groupsFailed: "Couldn't read the channels. Trying again…",
    loadingChannels: 'Loading channels…',
    loadingChannelsCount: (n: number): string => `Loading channels… ${n}`,
    groups: 'Groups',
  },
  pointer: { earlier: '‹ Earlier', later: 'Later ›', search: '⌕ Search', settings: '⚙ Settings' },
  /** Home's now and next lines. */
  nowNext: {
    now: (title: string): string => `Now · ${title}`,
    next: (range: string, title: string): string => `Next · ${range} · ${title}`,
    nextAt: (clock: string, title: string): string => `Next · ${clock} ${title}`,
  },
  /** Guide day labels. */
  guide: { today: 'Today' },
  /** Start: times, menus and matches. */
  start: {
    live: 'Live',
    inMinutes: (n: number): string => `In ${n} min`,
    tomorrowAt: (clock: string): string => `Tomorrow ${clock}`,
    empty: 'Your start page fills up as you watch.',
    follow: (side: string): string => `Follow ${side}`,
    unfollow: (side: string): string => `Unfollow ${side}`,
    putFirst: (competition: string): string => `Put ${competition} first`,
    dontPutFirst: (competition: string): string => `Don't put ${competition} first`,
    hide: (competition: string): string => `Hide ${competition}`,
    all: 'All',
    allOf: (sport: string): string => `All ${sport}`,
    eventGone: 'This event is no longer in your guide',
  },
  matches: {
    title: 'Matches',
    empty: 'No matches in your guide right now.',
    allSports: 'All sports',
    more: 'More…',
    sections: { live: 'Live now', today: 'Later today', tomorrow: 'Tomorrow' },
  },
  /** Search. */
  search: {
    title: 'Search',
    keyboardLabel: 'Channel, programme or title',
    vodRow: 'Movies & series',
    foldersRow: 'Folders',
    liveRow: 'Live & guide',
    guidePending: 'Guide results are being prepared',
    vodPending: 'Movies and series are being prepared',
    typeToSearch: 'Type to search channels, folders, programmes, movies and series',
    searching: 'Searching…',
    failed: "Couldn't search right now.",
    nothing: (query: string): string => `Nothing matches "${query}"`,
    nothingNote: (query: string, note: string): string => `Nothing matches "${query}" · ${note}`,
  },
  /** The left rail's labels. */
  rail: { start: 'Start', live: 'Live TV', movies: 'Movies', series: 'Series', search: 'Search', settings: 'Settings' },
  /** The wide tile's lines. */
  tile: {
    viewAll: 'View all',
    /** Search's card for matches in groups that Your countries hides. */
    hiddenContext: 'Hidden by Your countries',
    hiddenMore: (n: number): string => (n === 1 ? '1 more in a hidden group' : `${n} more in hidden groups`),
  },
  /** Folder search in Live TV's Groups sheet. */
  groupSearch: {
    keyboardLabel: 'Search folders',
    row: 'Search folders',
    found: (query: string, n: number): string => `"${query}" · ${n} found`,
    none: 'No folders match',
  },
} as const;
