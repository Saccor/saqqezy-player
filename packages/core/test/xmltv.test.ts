import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseXmltvDate } from '../src/xmltv/date.ts';
import { NO_STOP_MAX_MS, parseXmltv, type XmltvItem, type XmltvStats } from '../src/xmltv/parse.ts';

const fixture = readFileSync(new URL('./fixtures/basic.xml', import.meta.url), 'utf8');
async function* inChunks(s: string, size: number) { for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size); }

describe('parseXmltvDate', () => {
  test('handles offsets, missing offset (UTC) and missing seconds', () => {
    expect(parseXmltvDate('20261013190000 +0200')).toBe(Date.UTC(2026, 9, 13, 17, 0, 0));
    expect(parseXmltvDate('20261013190000 -0130')).toBe(Date.UTC(2026, 9, 13, 20, 30, 0));
    expect(parseXmltvDate('20261013190000')).toBe(Date.UTC(2026, 9, 13, 19, 0, 0));
    expect(parseXmltvDate('202610131900')).toBe(Date.UTC(2026, 9, 13, 19, 0, 0));
    expect(parseXmltvDate('bad')).toBeNaN();
  });
});

describe('parseXmltv', () => {
  test('yields channels and valid programmes even with tiny chunks', async () => {
    const stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 };
    const items: XmltvItem[] = [];
    for await (const it of parseXmltv(inChunks(fixture, 7), stats)) items.push(it);
    expect(items.filter((i) => i.type === 'channel')).toEqual([
      { type: 'channel', id: 'ch1.test', names: ['Channel 001', 'C1'] },
      { type: 'channel', id: 'ch2.test', names: ['Nyheter Åtta'] },
    ]);
    expect(items.filter((i) => i.type === 'programme')).toEqual([
      { type: 'programme', programme: { epgId: 'ch1.test', start: Date.UTC(2026, 9, 13, 17), stop: Date.UTC(2026, 9, 13, 17, 30), title: 'Evening Bulletin', desc: 'Synthetic & safe.' } },
      { type: 'programme', programme: { epgId: 'ch2.test', start: Date.UTC(2026, 9, 13, 17, 30), stop: Date.UTC(2026, 9, 13, 18), title: 'Åtta Show' } },
    ]);
    expect(stats).toEqual({ channels: 2, programmes: 2, skipped: 2 });
  });

  test('survives malformed xml by counting errors', async () => {
    const stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 };
    const xml = '<tv><programme start="20261013170000" stop="20261013180000" channel="a"><title>A &nbsp; B</title></programme></tv>';
    const items: XmltvItem[] = [];
    for await (const it of parseXmltv(inChunks(xml, 50), stats)) items.push(it);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(items).toHaveLength(1);
  });

  test('keeps CDATA text in title and desc', async () => {
    const xml = '<tv><programme start="20261013170000" stop="20261013180000" channel="a"><title><![CDATA[Show & Co]]></title><desc><![CDATA[Fun <b> & games]]></desc></programme></tv>';
    const items: XmltvItem[] = [];
    for await (const it of parseXmltv(inChunks(xml, 5))) items.push(it);
    expect(items).toEqual([{ type: 'programme', programme: { epgId: 'a', start: Date.UTC(2026, 9, 13, 17), stop: Date.UTC(2026, 9, 13, 18), title: 'Show & Co', desc: 'Fun <b> & games' } }]);
  });

  test('an empty first title does not block a later non-empty one', async () => {
    const xml = '<tv><programme start="20261013170000" stop="20261013180000" channel="a"><title lang="sv"></title><title lang="en">Real Title</title></programme></tv>';
    const items: XmltvItem[] = [];
    for await (const it of parseXmltv(inChunks(xml, 9))) items.push(it);
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<XmltvItem, { type: 'programme' }>).programme.title).toBe('Real Title');
  });

  test('detection fields go into extra; plain programmes have none', async () => {
    const xml = '<tv>'
      + '<programme start="20261013170000" stop="20261013190000" channel="a"><title>Northbridge FC v Eastport</title>'
      + '<sub-title>Test Cup: Round 3</sub-title><sub-title>ignored</sub-title><category lang="en">Sports</category><category>Football</category>'
      + '<icon src="http://img.test/e.png"/><live/></programme>'
      + '<programme start="20261013190000" stop="20261013200000" channel="a"><title>Replay</title><previously-shown/></programme>'
      + '<programme start="20261013200000" stop="20261013210000" channel="a"><title>Plain</title></programme>'
      + '</tv>';
    const items: XmltvItem[] = [];
    for await (const it of parseXmltv(inChunks(xml, 11))) items.push(it);
    expect(items[0]).toEqual({
      type: 'programme',
      programme: { epgId: 'a', start: Date.UTC(2026, 9, 13, 17), stop: Date.UTC(2026, 9, 13, 19), title: 'Northbridge FC v Eastport' },
      extra: { categories: ['Sports', 'Football'], live: true, subTitle: 'Test Cup: Round 3', icon: 'http://img.test/e.png' },
    });
    expect(items[1]).toMatchObject({ extra: { rerun: true } });
    expect(items[2]).toEqual({ type: 'programme', programme: { epgId: 'a', start: Date.UTC(2026, 9, 13, 20), stop: Date.UTC(2026, 9, 13, 21), title: 'Plain' } });
  });

  test('a channel icon is not taken as a programme icon', async () => {
    const xml = '<tv><channel id="a"><display-name>A</display-name><icon src="http://img.test/a.png"/></channel>'
      + '<programme start="20261013170000" stop="20261013180000" channel="a"><title>T</title></programme></tv>';
    const items: XmltvItem[] = [];
    for await (const it of parseXmltv(inChunks(xml, 9))) items.push(it);
    expect(items[1]).not.toHaveProperty('extra');
  });
});

describe('parseXmltv: programmes without stop', () => {
  const h = (hour: number, min = 0) => Date.UTC(2026, 9, 13, hour, min);
  const prog = (channel: string, start: string, stop: string | undefined, title: string) =>
    `<programme start="${start}"${stop === undefined ? '' : ` stop="${stop}"`} channel="${channel}"><title>${title}</title></programme>`;
  async function programmes(xml: string, size = 11) {
    const stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 };
    const out: { epgId: string; start: number; stop: number; title: string }[] = [];
    for await (const it of parseXmltv(inChunks(xml, size), stats)) if (it.type === 'programme') out.push(it.programme);
    return { out, stats };
  }
  const byStart = <T extends { epgId: string; start: number }>(a: T[]) => [...a].sort((x, y) => x.epgId.localeCompare(y.epgId) || x.start - y.start);

  test('each one ends where the next one on its channel starts', async () => {
    const { out, stats } = await programmes(`<tv>${
      prog('a', '20261013170000', undefined, 'A1')}${prog('b', '20261013170000', undefined, 'B1')}${
      prog('a', '20261013173000', '', 'A2')}${prog('a', '20261013180000', '20261013190000', 'A3')}${
      prog('b', '20261013181500', undefined, 'B2')}</tv>`);
    expect(byStart(out)).toEqual([
      { epgId: 'a', start: h(17), stop: h(17, 30), title: 'A1' },
      { epgId: 'a', start: h(17, 30), stop: h(18), title: 'A2' },
      { epgId: 'a', start: h(18), stop: h(19), title: 'A3' },
      { epgId: 'b', start: h(17), stop: h(18, 15), title: 'B1' },
      // The last one on its channel: start + NO_STOP_MAX_MS, flushed at the end.
      { epgId: 'b', start: h(18, 15), stop: h(18, 15) + NO_STOP_MAX_MS, title: 'B2' },
    ]);
    expect(stats).toEqual({ channels: 0, programmes: 5, skipped: 0 });
  });

  test('a long gap or an out-of-order successor caps it at NO_STOP_MAX_MS', async () => {
    const { out } = await programmes(`<tv>${
      prog('a', '20261013080000', undefined, 'Gap')}${prog('a', '20261013200000', '20261013210000', 'Late')}${
      prog('c', '20261013120000', undefined, 'C1')}${prog('c', '20261013110000', '20261013120000', 'C0')}</tv>`);
    expect(byStart(out)).toEqual([
      { epgId: 'a', start: h(8), stop: h(8) + NO_STOP_MAX_MS, title: 'Gap' },
      { epgId: 'a', start: h(20), stop: h(21), title: 'Late' },
      { epgId: 'c', start: h(11), stop: h(12), title: 'C0' },
      { epgId: 'c', start: h(12), stop: h(12) + NO_STOP_MAX_MS, title: 'C1' },
    ]);
  });

  test('a stop that is present but unreadable is still skipped', async () => {
    const { out, stats } = await programmes(`<tv>${prog('a', '20261013170000', 'bad', 'X')}</tv>`);
    expect(out).toEqual([]);
    expect(stats.skipped).toBe(1);
  });

  test('a streaming consumer gets each one as soon as its successor is read', async () => {
    const xml = `<tv>${prog('a', '20261013170000', undefined, 'A1')}${prog('a', '20261013180000', undefined, 'A2')}`;
    const seen: string[] = [];
    async function* chunks() {
      yield xml;
      // A1 is out before the document goes on; A2 waits for its successor or the end.
      expect(seen).toEqual(['A1']);
      yield '</tv>';
    }
    for await (const it of parseXmltv(chunks())) if (it.type === 'programme') seen.push(it.programme.title);
    expect(seen).toEqual(['A1', 'A2']);
  });
});
