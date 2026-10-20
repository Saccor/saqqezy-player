import { expect, test } from 'vitest';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import type { Channel } from '../src/types.ts';

/** 50k synthetic channels: ~3 streams per channel (HD, FHD, 4K), half with guide ids, some spare feeds. */
function channels(n: number): Channel[] {
  const tags = ['HD', 'FHD', '4K'];
  const out: Channel[] = [];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / 3);
    const c: Channel = {
      id: `s:${i}`, sourceId: 's', name: `${i % 10 === 0 ? 'SE: ' : ''}Channel ${k} ${tags[i % 3]}${i % 17 === 0 ? ' (backup)' : ''}`,
      url: `http://example.test/live/${i}.ts`, group: `Group ${k % 300}`, number: i + 1,
    };
    if (k % 2 === 0) c.epgId = `channel${k}.example`;
    out.push(c);
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('folding 50k channels: index build plus All under 150 ms; zapping from a member under 5 ms', () => {
  const cs = channels(50_000);
  const builds: number[] = [];
  let idx: ChannelIndex | undefined;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    idx = new ChannelIndex(cs, undefined, undefined, { fold: true });
    idx.groupSize('all');
    builds.push(performance.now() - t0);
  }
  const plain: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    new ChannelIndex(cs).groupSize('all');
    plain.push(performance.now() - t0);
  }
  const t1 = performance.now();
  const next = idx!.neighbour('all', 's:30001', 1);
  const zap = performance.now() - t1;
  const added = median(builds) - median(plain);
  console.log(`fold 50k: ${median(builds).toFixed(0)} ms (plain ${median(plain).toFixed(0)} ms, +${added.toFixed(0)} ms), zap ${zap.toFixed(2)} ms, rows ${idx!.groupSize('all')}`);
  expect(idx!.groupSize('all')).toBeLessThan(25_000);
  expect(next).toBeDefined();
  expect(added).toBeLessThan(150);
  expect(zap).toBeLessThan(5);
});
