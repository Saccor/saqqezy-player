// apps/tv/src/components/sheetLogic.test.ts
import { describe, expect, it } from 'vitest';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { LAYOUT } from '../shell/theme.ts';
import {
  SHEET_MAX_ROWS, SHEET_PITCH, SHEET_W, dialogFrame, fromMenuItem, fromOptionItem, fromPickerRow, sheetClamp, sheetFollow, sheetFooter,
  dialogButtons, dialogLineCount, sheetFrame, sheetMore, sheetScroll, sheetStep, stackOpen, stackPop, stackPush, stackRestore, stackTop, tabStep, type SheetPage, type SheetRow,
} from './sheetLogic.ts';

const r = (id: string, extra: Partial<SheetRow> = {}): SheetRow => ({ id, label: id, ...extra });
const h = (id: string): SheetRow => ({ id, label: id, heading: true });

describe('sheet selection', () => {
  it('skips headings and clamps to the list', () => {
    const rows = [h('Group'), r('a'), r('b'), h('Other'), r('c')];
    expect(sheetClamp(0, rows)).toBe(1);
    expect(sheetClamp(9, rows)).toBe(4);
    expect(sheetStep(2, 1, rows)).toBe(4);
    expect(sheetStep(1, -1, rows)).toBe(1);
    expect(sheetClamp(0, [])).toBe(0);
  });
  it("'id' follow keeps the same row when the list changes, else the same index (ContextMenu rule)", () => {
    const before = [r('watch'), r('fav'), r('cancel')];
    const after = [r('watch'), r('fromStart'), r('fav'), r('cancel')];
    expect(sheetFollow('fav', 1, after)).toBe(2);
    expect(sheetFollow('gone', 1, after)).toBe(1);
    expect(sheetFollow(undefined, 5, before)).toBe(2);
  });
  it('scrolls at most 7 rows into view, moving as little as possible', () => {
    expect(SHEET_MAX_ROWS).toBe(7);
    expect(sheetScroll(3, 0, 20)).toBe(0);
    expect(sheetScroll(7, 0, 20)).toBe(1);
    expect(sheetScroll(2, 5, 20)).toBe(2);
  });
});

describe('sheet footer: status and attribution only, never key hints', () => {
  it('no help, no footer, no scroll marks: no footer line', () => {
    expect(sheetFooter([r('a')], 0, undefined, '')).toEqual([]);
  });
  it('the scroll marks and the footer share one line', () => {
    expect(sheetMore(0, 10)).toBe('▼');
    expect(sheetMore(2, 10)).toBe('▲ ▼');
    expect(sheetMore(3, 10)).toBe('▲');
    expect(sheetMore(0, 7)).toBe('');
    expect(sheetFooter([r('a')], 0, 'Loading…', '▼')).toEqual(['▼ · Loading…']);
  });
  it('a row with help: its help on line 1 (empty for rows without), so the sheet never jumps', () => {
    const rows = [r('a', { help: 'Synthetic.Release.Full.Name' }), r('b')];
    expect(sheetFooter(rows, 0, 'Attribution line', '')).toEqual(['Synthetic.Release.Full.Name', 'Attribution line']);
    expect(sheetFooter(rows, 1, undefined, '')).toEqual(['']);
  });
});

describe('sheet frames', () => {
  it('side: right edge at the safe area, top at the safe area, 640 wide, sized to its rows', () => {
    const f = sheetFrame('side', 7, 0, false);
    expect(f).toEqual({ x: LAYOUT.width - LAYOUT.safeX - SHEET_W, y: LAYOUT.safeY, w: SHEET_W, h: 24 + 64 + 7 * SHEET_PITCH - 8 + 24 });
  });
  it('footer lines and tabs add their height', () => {
    expect(sheetFrame('side', 7, 2, false).h).toBe(664 + 8 + 64);
    expect(sheetFrame('side', 3, 0, true).h).toBe(24 + 64 + 64 + 3 * SHEET_PITCH - 8 + 24);
  });
  it('bottom: full width inside the safe area, its bottom at the safe area', () => {
    const f = sheetFrame('bottom', 2, 0, false);
    expect(f.x).toBe(LAYOUT.safeX);
    expect(f.w).toBe(LAYOUT.width - LAYOUT.safeX * 2);
    expect(f.y + f.h).toBe(LAYOUT.height - LAYOUT.safeY);
  });
  it('center: centred both ways', () => {
    const f = sheetFrame('center', 2, 0, false);
    expect(f.x).toBe((LAYOUT.width - SHEET_W) / 2);
    expect(f.y).toBe((LAYOUT.height - f.h) / 2);
  });
  it('dialog: title, optional line and detail, buttons, centred', () => {
    expect(dialogFrame(0, false, 64)).toMatchObject({ w: 720, h: 256, titleY: 48, buttonsY: 144 });
    expect(dialogFrame(1, false, 64)).toMatchObject({ h: 308, lineY: 112, buttonsY: 196 });
    expect(dialogFrame(1, true, 64)).toMatchObject({ h: 372, lineY: 112, detailY: 164, buttonsY: 260 });
    const d = dialogFrame(0, false, 64);
    expect(d.x).toBe((LAYOUT.width - 720) / 2);
    expect(d.y).toBe((LAYOUT.height - 256) / 2);
  });
});

describe('dialog lines and buttons', () => {
  const per = (n: number) => (text: string) => text.length * n;
  it('a line that fits the 624 px box is one line, a longer one is two', () => {
    expect(dialogLineCount(undefined, per(10))).toBe(0);
    expect(dialogLineCount('x'.repeat(62), per(10))).toBe(1);
    expect(dialogLineCount('x'.repeat(63), per(10))).toBe(2);
  });
  it('a second line makes the box one body line taller', () => {
    expect(dialogFrame(2, false, 64).h).toBe(dialogFrame(1, false, 64).h + 36);
    expect(dialogFrame(2, false, 64)).toMatchObject({ lineY: 112, buttonsY: 232 });
  });
  it('buttons fit their label with 24 px each side, 200 px at least, equal widths', () => {
    expect(dialogButtons(['Yes', 'No'], per(10))).toEqual({ w: 200, rowW: 200 * 2 + LAYOUT.gap });
    expect(dialogButtons(['Stop', 'Keep watching'], per(14))).toEqual({ w: 13 * 14 + 48, rowW: (13 * 14 + 48) * 2 + LAYOUT.gap });
    expect(dialogButtons(['Done'], per(14))).toEqual({ w: 200, rowW: 200 });
  });
});

describe('tabs and sub-pages', () => {
  it('tabs clamp at the ends', () => {
    expect(tabStep(0, -1, 3)).toBe(0);
    expect(tabStep(1, 1, 3)).toBe(2);
    expect(tabStep(2, 1, 3)).toBe(2);
  });
  it('a sub-page opens in place and Back returns to the row that opened it', () => {
    const sub: SheetPage = { id: 'audio', title: 'Audio', rows: [r('a1'), r('a2')] };
    const root: SheetPage = { id: 'root', title: 'Options', rows: [r('x'), r('audio', { page: sub })] };
    const s1 = stackPush(stackOpen(root), sub, 1);
    expect(stackTop(s1).id).toBe('audio');
    expect(stackRestore(s1)).toBe(1);
    const s0 = stackPop(s1);
    expect(s0 && stackTop(s0).id).toBe('root');
    expect(stackPop(stackOpen(root))).toBeUndefined();
  });
});

describe('adapters keep the old rows exactly', () => {
  it('picker rows: list, new and heading', () => {
    const list: PickerRow = { kind: 'list', id: 'l1', label: 'Demo list', checked: true, help: 'Help', icon: { badge: 'SE' }, more: true };
    expect(fromPickerRow(list, 0)).toEqual({ id: 'l1', label: 'Demo list', checked: true, help: 'Help', icon: { badge: 'SE' }, more: true });
    expect(fromPickerRow({ kind: 'new', label: 'New list…' }, 3)).toEqual({ id: 'new:3', label: 'New list…', quiet: true });
    expect(fromPickerRow({ kind: 'heading', label: 'Other folders' }, 4)).toEqual({ id: 'heading:4', label: 'Other folders', heading: true });
  });
  it('option items and menu items', () => {
    expect(fromOptionItem({ id: 'aspect', label: 'Aspect ratio', value: 'Fit' })).toEqual({ id: 'aspect', label: 'Aspect ratio', value: 'Fit' });
    expect(fromOptionItem({ id: 'info', label: 'Stream info' })).toEqual({ id: 'info', label: 'Stream info' });
    expect(fromMenuItem({ action: 'watch', label: 'Watch' })).toEqual({ id: 'watch', label: 'Watch' });
  });
});
