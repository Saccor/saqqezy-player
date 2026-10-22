import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SourceNetworkError, StorageWriteError } from '../src/errors.ts';
import { countsAsRefreshFailure, recordRefreshFailure, refreshBackedOff } from '../src/service/refreshBackoff.ts';

describe('countsAsRefreshFailure', () => {
  test('a list that could not be saved counts: the next launch must not download it again', () => {
    expect(countsAsRefreshFailure(new StorageWriteError('vod:series', new Error('quota')))).toBe(true);
    expect(countsAsRefreshFailure(new SourceNetworkError('x'))).toBe(true);
    expect(countsAsRefreshFailure(new Error('other'))).toBe(false);
  });
});

describe('storage failures hold off a foreground refresh too', () => {
  test('a record marked as storage backs off even when nothing is shown', async () => {
    const s = new MemoryStorage();
    await recordRefreshFailure(s, 'x', 'vod:series', 1000, 'storage');
    expect(await refreshBackedOff(s, 'x', 'vod:series', 2000)).toBe(true);
    expect(await refreshBackedOff(s, 'x', 'vod:series', 2000, { foreground: true })).toBe(true);
    const t = new MemoryStorage();
    await recordRefreshFailure(t, 'x', 'vod:series', 1000);
    expect(await refreshBackedOff(t, 'x', 'vod:series', 2000, { foreground: true })).toBe(false);
  });
});
