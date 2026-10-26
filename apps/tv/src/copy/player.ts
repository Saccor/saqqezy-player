/** The live and VOD players' copy (spec 2026-10-26 §1.4). */
export const PLAYER_COPY = {
  stillWatching: 'Still watching?',
  stoppingIn: (s: number): string => `Stopping in ${s} s`,
  stop: 'Stop',
  keepWatching: 'Keep watching',
  audioTrack: 'Audio track',
  options: 'Options',
  streamInfo: 'Stream info',
  noChannel: (n: number): string => `No channel ${n}`,
  previousUnavailable: 'Previous channel not available',
  noAudioList: 'No audio track list for this stream',
  oneAudio: 'Only one audio track',
  selected: 'Selected',
  default: 'Default',
  aspectRatio: 'Aspect ratio',
  sleepTimer: 'Sleep timer',
  on: 'On',
  off: 'Off',
  live: 'LIVE',
  behindLive: (s: number): string => `−${s} s`,
  pausedAfterReload: 'Paused after reload',
  /** Stream info's status line. */
  status: {
    idle: 'Idle',
    loading: 'Loading',
    playing: 'Playing',
    reconnecting: 'Reconnecting',
    failed: (reason: string): string => `Failed (${reason})`,
    ended: 'Ended',
  },
  /** Dynamic range names and their fallbacks. */
  range: {
    dolbyVision: 'Dolby Vision',
    dolbyVisionProfile: (profile: number): string => `Dolby Vision ${profile}`,
    dolbyVisionTitle: (name: string): string => `${name} (title)`,
    dolbyVisionFallback: (name: string, fallback: string): string => `${name} (${fallback})`,
    fallback: { none: 'no HDR10 base', hdr10: 'HDR10 base', hlg: 'HLG base', sdr: 'SDR base' },
    names: { sdr: 'SDR', hdr10: 'HDR10', hdr10plus: 'HDR10+', hlg: 'HLG' },
  },
  /** Subtitle badges. */
  badge: {
    subtitles: 'Subtitles',
    forcedSubtitles: 'Forced subtitles',
    cc: 'CC',
    subtitlesIn: (lang: string): string => `${lang} subtitles`,
    forcedIn: (lang: string): string => `${lang} forced`,
    ccIn: (lang: string): string => `${lang} CC`,
  },
  /** One live channel's source labels. */
  source: { auto: 'Auto', playing: 'Playing', didntPlay: "Didn't play" },
  /** Diagnostics' Multiview line. */
  windows: {
    oneWindow: (why: string): string => `1 window: ${why}`,
    upTo: (n: number): string => `Up to ${n} windows`,
    notOnDevice: 'Not on this device',
    why: {
      subScaler: 'this TV refused a second picture',
      noInstance: 'this TV had no second player available',
      audioStream: 'this TV cannot move the sound between windows',
    },
  },
} as const;
