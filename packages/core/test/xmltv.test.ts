import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseXmltvDate } from '../src/xmltv/date.ts';
import { parseXmltv, type XmltvItem, type XmltvStats } from '../src/xmltv/parse.ts';

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
});
