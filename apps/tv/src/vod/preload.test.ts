import { describe, expect, test, vi } from 'vitest';
import { createVodPreloader } from './preload.ts';

function harness() {
  const preload = vi.fn(async () => undefined);
  const queued: (() => void)[] = [];
  const onStatus = createVodPreloader({ preload, schedule: (run) => queued.push(run) });
  const flush = () => queued.splice(0).forEach((run) => run());
  return { preload, queued, onStatus, flush };
}

describe('createVodPreloader', () => {
  test('waits for playing, then preloads once per source in idle time', () => {
    const h = harness();
    h.onStatus('loading', 's1');
    h.onStatus(undefined, 's1');
    expect(h.queued).toHaveLength(0);
    h.onStatus('playing', 's1');
    h.onStatus('playing', 's1');
    expect(h.queued).toHaveLength(1);
    expect(h.preload).not.toHaveBeenCalled();
    h.flush();
    expect(h.preload).toHaveBeenCalledTimes(1);
    h.onStatus('playing', 's1');
    h.flush();
    expect(h.preload).toHaveBeenCalledTimes(1);
  });

  test('a new active source preloads again; no source never preloads', () => {
    const h = harness();
    h.onStatus('playing', undefined);
    expect(h.queued).toHaveLength(0);
    h.onStatus('playing', 's1');
    h.flush();
    h.onStatus('playing', 's2');
    h.flush();
    expect(h.preload).toHaveBeenCalledTimes(2);
  });

  test('a failed preload is swallowed', async () => {
    const preload = vi.fn(async () => { throw new Error('boom'); });
    const queued: (() => void)[] = [];
    const onStatus = createVodPreloader({ preload, schedule: (run) => queued.push(run) });
    onStatus('playing', 's1');
    queued[0]!();
    await Promise.resolve();
    expect(preload).toHaveBeenCalledTimes(1);
  });
});
