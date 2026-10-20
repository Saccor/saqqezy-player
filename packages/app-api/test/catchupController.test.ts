import { describe, expect, test } from 'vitest';
import type { Channel, SourceConfig, SourceService } from '@iptv/core';
import { CatchupController, REFINED_MAX_CHANNELS, type CatchupContext } from '../src/catchupController.ts';

const NOW = Date.UTC(2026, 9, 20, 18, 0);
const H = 3_600_000;
const source = { kind: 'xtream', id: 's', name: 'X', server: 'http://x.test', username: 'u', password: 'p' } as SourceConfig;

function ctxFor(n: number): CatchupContext {
  const channel: Channel = {
    id: `s:x${n}`, sourceId: 's', name: `C${n}`, url: `http://x.test/live/u/p/${n}.ts`, group: 'G', number: n, epgId: `c${n}.test`,
    cu: { mode: 'xc', days: 7 },
  };
  return { sourceId: 's', source, channel, shiftHours: 0 };
}

describe('CatchupController: refined listings are held for the latest channels only', () => {
  test(`at most ${REFINED_MAX_CHANNELS} channels; the least recently used goes first`, async () => {
    const start = NOW - 2 * H;
    const service = {
      archiveTable: async (_id: string, streamId: number) => [
        { epgId: `c${streamId}.test`, start, stop: start + H, title: `P${streamId}`, hasArchive: true },
      ],
    } as unknown as SourceService;
    const c = new CatchupController({ service, now: () => NOW, onRefined: () => undefined, note: () => undefined });
    for (let n = 1; n <= REFINED_MAX_CHANNELS; n++) await c.refine(ctxFor(n));
    expect(c.refinedProgramme(ctxFor(1), start)?.title).toBe('P1'); // read: channel 1 is now the most recent
    await c.refine(ctxFor(REFINED_MAX_CHANNELS + 1));
    expect(c.refinedProgramme(ctxFor(1), start)?.title).toBe('P1');
    expect(c.refinedProgramme(ctxFor(2), start)).toBeUndefined(); // the least recently used was dropped
    expect(c.refinedProgramme(ctxFor(REFINED_MAX_CHANNELS + 1), start)?.title).toBe(`P${REFINED_MAX_CHANNELS + 1}`);
    let held = 0;
    for (let n = 1; n <= REFINED_MAX_CHANNELS + 1; n++) if (c.refinedProgramme(ctxFor(n), start)) held++;
    expect(held).toBe(REFINED_MAX_CHANNELS);
  });
});
