/** The live and VOD players' copy (filled in Task 16). */
export const PLAYER_COPY = {
  stillWatching: 'Still watching?',
  stoppingIn: (s: number): string => `Stopping in ${s} s`,
  stop: 'Stop',
  keepWatching: 'Keep watching',
} as const;
