import { rowSlots, type RowFrame } from '../components/rowSlots.ts';

/**
 * Movies and Series browse (UI revamp §2.2): the rail, the "All categories" header and the poster rows.
 * Pure: no Solid, no Lightning.
 */
export type BrowseArea = 'rail' | 'header' | 'rows';

/** Where the poster rows go: the focused row on top, the rows after it below (`rowSlots`). */
export function browseRowSlots(rowCount: number, rowH: number, row: number, frame: RowFrame, mode: 'peek' | 'whole'): { index: number; y: number }[] {
  const heights = Array.from({ length: rowCount }, () => rowH);
  return rowSlots(heights, Math.max(0, Math.min(row, rowCount - 1)), frame, mode);
}

/** Green opens the grid on All only while the catalogue is ready: on loading, empty or failed it would show nothing. */
export const greenOpensGrid = (status: string | undefined): boolean => status === 'ready';
