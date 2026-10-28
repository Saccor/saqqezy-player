import { describe, expect, it } from 'vitest';
import { LINE, SPACE, TYPE } from '../shell/theme.ts';
import { INFO_PROGRESS_W, KV_LINE_H, infoBlockLayout, keyValueHeight, metaLineLayout, overlineWidth } from './infoBlockLogic.ts';

describe('InfoBlock layout (spec 2026-10-26 §1.3: title, meta line, optional progress, optional one-line description)', () => {
  it('title only', () => {
    expect(infoBlockLayout({ overline: false, titleSize: 'title', metaLine: false, descriptionLines: 0 }))
      .toEqual({ overlineY: 0, titleY: 0, metaY: LINE.title + SPACE.s, descriptionY: LINE.title + SPACE.s, height: LINE.title });
  });
  it('overline, title, meta and a one-line description stack with 8 px gaps', () => {
    const l = infoBlockLayout({ overline: true, titleSize: 'title', metaLine: true, descriptionLines: 1 });
    expect(l.titleY).toBe(LINE.meta + SPACE.s);
    expect(l.metaY).toBe(l.titleY + LINE.title + SPACE.s);
    expect(l.descriptionY).toBe(l.metaY + LINE.meta + SPACE.s);
    expect(l.height).toBe(l.descriptionY + LINE.body);
  });
  it('a hero title is taller; more description lines add height', () => {
    const l = infoBlockLayout({ overline: false, titleSize: 'hero', metaLine: false, descriptionLines: 3 });
    expect(l.metaY).toBe(TYPE.hero + SPACE.s + SPACE.s);
    expect(l.height).toBe(l.descriptionY + 3 * LINE.body);
  });
  it('the meta line: text, then the progress track, then the trailing text', () => {
    expect(metaLineLayout(200, true)).toEqual({ trackX: 200 + SPACE.m, trailingX: 200 + SPACE.m + INFO_PROGRESS_W + SPACE.m });
    expect(metaLineLayout(200, false)).toEqual({ trackX: 200 + SPACE.m, trailingX: 200 + SPACE.m });
  });
  it('the overline gives way to badges on its line: width minus the badges and a gap', () => {
    expect(overlineWidth(800, 0)).toBe(800);
    expect(overlineWidth(800, 300)).toBe(800 - 300 - SPACE.m);
    expect(overlineWidth(200, 300)).toBe(0);
  });
});

describe('KeyValuePanel height', () => {
  it('lines, an optional title band, padding when framed', () => {
    expect(keyValueHeight(3, false, false)).toBe(3 * KV_LINE_H);
    expect(keyValueHeight(3, true, true)).toBe(SPACE.l * 2 + LINE.body + SPACE.m + 3 * KV_LINE_H);
  });
});
