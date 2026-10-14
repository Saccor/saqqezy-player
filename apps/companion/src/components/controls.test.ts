import { describe, expect, it } from 'vitest';
import { sendAndSync } from './controls.ts';

describe('sendAndSync', () => {
  it('puts a switch back to the model when the change was not made (early return or failure)', async () => {
    const model = { on: false };
    const el = { checked: true }; // the browser already flipped it on click
    await sendAndSync(async () => 'error', [el], () => model.on);
    expect(el.checked).toBe(false);
  });

  it('keeps the new value when the model followed the change', async () => {
    const model = { on: false };
    const el = { checked: true };
    await sendAndSync(async () => { model.on = true; return undefined; }, [el], () => model.on);
    expect(el.checked).toBe(true);
  });

  it('resyncs every radio of a group, not only the one clicked', async () => {
    const mode = 'provider';
    const radios = [{ value: 'provider', checked: false }, { value: 'number', checked: true }, { value: 'name', checked: false }];
    await sendAndSync(async () => undefined, radios, (r) => r.value === mode);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
  });

  it('resyncs even when sending throws', async () => {
    const el = { checked: true };
    await expect(sendAndSync(async () => { throw new Error('x'); }, [el], () => false)).rejects.toThrow('x');
    expect(el.checked).toBe(false);
  });
});
