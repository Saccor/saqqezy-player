/**
 * Movies and Series browse (UI revamp §2.2): the rail, the "All categories" header and the poster rows.
 * Pure: no Solid, no Lightning.
 */
export type BrowseArea = 'rail' | 'header' | 'rows';

/** Green opens the grid on All only while the catalogue is ready: on loading, empty or failed it would show nothing. */
export const greenOpensGrid = (status: string | undefined): boolean => status === 'ready';
