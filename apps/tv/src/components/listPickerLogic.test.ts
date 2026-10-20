import { describe, expect, it } from 'vitest';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { DEFAULT_PICKER_HINT, pickerFooter } from './listPickerLogic.ts';

const row = (id: string, help?: string): PickerRow => ({ kind: 'list', id, label: id, checked: false, ...(help ? { help } : {}) });

describe('pickerFooter', () => {
  it('no row has help: one line, the hint (or the default), after the scroll marks', () => {
    expect(pickerFooter([row('a')], 0, 'Ok chooses · Back closes', '')).toEqual(['Ok chooses · Back closes']);
    expect(pickerFooter([row('a')], 0, undefined, '')).toEqual([DEFAULT_PICKER_HINT]);
    expect(pickerFooter([row('a')], 0, 'Hint', '▼')).toEqual(['▼ · Hint']);
  });

  it('a row with help: its help on line 1, the hint always on line 2', () => {
    const rows = [row('a', 'Synthetic.Release.Full.Name'), row('b')];
    expect(pickerFooter(rows, 0, 'Subtitles provided by the service', '')).toEqual(['Synthetic.Release.Full.Name', 'Subtitles provided by the service']);
    expect(pickerFooter(rows, 0, 'Loading subtitles…', '▼')).toEqual(['Synthetic.Release.Full.Name', '▼ · Loading subtitles…']);
    // The selected row has none: line 1 stays (empty), so the panel does not jump.
    expect(pickerFooter(rows, 1, 'Ok chooses · Back closes', '')).toEqual(['', 'Ok chooses · Back closes']);
    expect(pickerFooter(rows, 5, undefined, '')).toEqual(['', DEFAULT_PICKER_HINT]);
  });
});
