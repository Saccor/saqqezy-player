import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CatchupCollector, resolveCatchup } from '../src/catchup/m3uCatchup.ts';
import { parseM3u, type M3uEntry, type ParseStats } from '../src/m3u/parse.ts';
import { m3uEntriesToChannels } from '../src/m3u/toChannels.ts';
import { splitLines } from '../src/text/lines.ts';

async function* once(s: string) { yield s; }
async function parse(text: string) {
  const stats: ParseStats = { entries: 0, skipped: 0 };
  const out: M3uEntry[] = [];
  for await (const e of parseM3u(splitLines(once(text)), stats)) out.push(e);
  return { out, stats };
}
const fixture = readFileSync(new URL('./fixtures/catchup/modes.m3u', import.meta.url), 'utf8');

describe('parseM3u reads catch-up attributes', () => {
  test('raw values, with the header line as defaults (entry wins field by field)', async () => {
    const { out } = await parse(fixture);
    expect(out[0]!.catchup).toEqual({ mode: 'shift', days: 2, corrMin: 60 });
    expect(out[1]!.catchup).toEqual({ mode: 'default', source: 'http://archive.test/a?start={utc}&end={utcend}', days: 5, corrMin: 60 });
    expect(out[2]!.catchup).toEqual({ mode: 'vod', source: 'http://archive.test/c/{Y}{m}{d}/{H}{M}.ts', days: 9, corrMin: -150 });
    expect(out[3]!.catchup?.days).toBe(4);
    expect(out[4]!.catchup).toEqual({ mode: 'timeshift', days: 45, corrMin: 60 });
  });

  test('any case; a correction outside -12..+14 is clamped, in 15 min steps', async () => {
    const { out } = await parse('#EXTINF:-1 CATCHUP="Shift" Catchup-Days="3" catchup-correction="20",A\nhttp://s.test/a.m3u8\n'
      + '#EXTINF:-1 catchup="shift" catchup-correction="0.3",B\nhttp://s.test/b.m3u8\n');
    expect(out[0]!.catchup).toEqual({ mode: 'shift', days: 3, corrMin: 14 * 60 });
    expect(out[1]!.catchup?.corrMin).toBe(15);
  });

  test('entries without catch-up are byte-identical to before (ids and dedupe untouched)', async () => {
    const plain = '#EXTM3U x-tvg-url="http://example.test/epg.xml"\n#EXTINF:-1 tvg-id="a" group-title="G",A\nhttp://s.test/a.ts\n';
    const { out } = await parse(plain);
    expect(out[0]).toEqual({ name: 'A', url: 'http://s.test/a.ts', tvgId: 'a', groupTitle: 'G' });
    expect('catchup' in out[0]!).toBe(false);
    const [ch] = m3uEntriesToChannels('s', out, new CatchupCollector());
    expect(ch).toEqual(m3uEntriesToChannels('s', out)[0]);
    expect('catchup' in ch!).toBe(false);
  });
});

describe('m3uEntriesToChannels resolves catch-up', () => {
  test('every mode and alias, inference, validation, interning and counts', async () => {
    const { out } = await parse(fixture);
    const col = new CatchupCollector();
    const ch = m3uEntriesToChannels('s', out, col);
    const by = (name: string) => ch.find((c) => c.name === name)!.catchup;
    expect(by('Header defaults')).toEqual({ mode: 'shift', days: 2, corrMin: 60 });
    expect(by('Default override')).toEqual({ mode: 'default', days: 5, tpl: 0, corrMin: 60 });
    expect(by('Default alias vod')).toEqual({ mode: 'default', days: 9, tpl: 1, corrMin: -150 });
    expect(by('Append')).toEqual({ mode: 'append', days: 4, tpl: 2, corrMin: 60 });
    expect(by('Shift alias')).toEqual({ mode: 'shift', days: 30, corrMin: 60 });
    expect(by('Flussonic HLS')).toEqual({ mode: 'flussonic', days: 2, corrMin: 60 });
    expect(by('Flussonic TS')).toEqual({ mode: 'flussonic', days: 2, corrMin: 60 });
    expect(by('XC long')).toEqual({ mode: 'xc', days: 2, corrMin: 60 });
    expect(by('XC short')).toEqual({ mode: 'xc', days: 2, corrMin: 60 });
    for (const n of ['Flussonic wrong shape', 'XC wrong shape', 'Unknown placeholder', 'Unknown mode']) expect(by(n), n).toBeUndefined();
    expect(col.templates).toEqual([
      'http://archive.test/a?start={utc}&end={utcend}', 'http://archive.test/c/{Y}{m}{d}/{H}{M}.ts', '?utc={utc}&lutc={lutc}',
    ]);
    expect(col.channels).toBe(9);
    expect(col.unsupported).toBe(4);
  });

  test('one shared template is stored once', async () => {
    const lines = ['#EXTM3U catchup="default" catchup-source="http://a.test/{utc}.ts"'];
    for (let i = 0; i < 50; i++) lines.push(`#EXTINF:-1,C${i}`, `http://s.test/${i}.m3u8`);
    const col = new CatchupCollector();
    const ch = m3uEntriesToChannels('s', (await parse(lines.join('\n'))).out, col);
    expect(col.templates).toHaveLength(1);
    expect(ch.every((c) => c.catchup?.tpl === 0 && c.catchup.days === 3)).toBe(true);
  });

  test('past 256 distinct templates, entries get no catch-up and count as unsupported', () => {
    const col = new CatchupCollector();
    for (let i = 0; i < 256; i++) expect(resolveCatchup({ mode: 'default', source: `http://a.test/${i}/{utc}` }, 'http://s.test/x', col)).toBeDefined();
    expect(resolveCatchup({ mode: 'default', source: 'http://a.test/new/{utc}' }, 'http://s.test/x', col)).toBeUndefined();
    expect(resolveCatchup({ mode: 'default', source: 'http://a.test/0/{utc}' }, 'http://s.test/x', col)).toBeDefined();
    expect(col.unsupported).toBe(1);
  });
});

describe('mode inference (§1.2)', () => {
  const col = () => new CatchupCollector();
  test('an absolute source is default; a relative one append', () => {
    expect(resolveCatchup({ source: 'https://a.test/{utc}' }, 'http://s.test/x.m3u8', col())?.mode).toBe('default');
    expect(resolveCatchup({ source: '?utc={utc}' }, 'http://s.test/x.m3u8', col())?.mode).toBe('append');
  });
  test('days only: xc for the Xtream live shape, else shift', () => {
    expect(resolveCatchup({ days: 2 }, 'http://s.test/live/u/p/1.ts', col())).toEqual({ mode: 'xc', days: 2 });
    expect(resolveCatchup({ days: 2 }, 'http://s.test/x.m3u8', col())).toEqual({ mode: 'shift', days: 2 });
  });
  test('neither: no catch-up; a correction alone is not catch-up', () => {
    expect(resolveCatchup({}, 'http://s.test/x.m3u8', col())).toBeUndefined();
    expect(resolveCatchup({ corrMin: 60 }, 'http://s.test/x.m3u8', col())).toBeUndefined();
  });
  test('days: default 3 with a mode, capped at 30, at least 1', () => {
    expect(resolveCatchup({ mode: 'shift' }, 'http://s.test/x', col())?.days).toBe(3);
    expect(resolveCatchup({ mode: 'shift', days: 99 }, 'http://s.test/x', col())?.days).toBe(30);
    expect(resolveCatchup({ mode: 'shift', days: 0 }, 'http://s.test/x', col())?.days).toBe(3);
  });
  test('default and append need a valid source; default needs an absolute one', () => {
    const c = col();
    expect(resolveCatchup({ mode: 'default' }, 'http://s.test/x', c)).toBeUndefined();
    expect(resolveCatchup({ mode: 'append' }, 'http://s.test/x', c)).toBeUndefined();
    expect(resolveCatchup({ mode: 'default', source: '/rel/{utc}' }, 'http://s.test/x', c)).toBeUndefined();
    expect(c.unsupported).toBe(3);
  });
});
