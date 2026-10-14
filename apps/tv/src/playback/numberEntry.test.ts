import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNumberEntry } from './numberEntry.ts';

describe('createNumberEntry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const e = createNumberEntry({ idleMs: 1500, maxDigits: 4, onChange, onSubmit });
    return { e, onChange, onSubmit };
  };

  it('accumulates digits and submits after 1.5 s idle', () => {
    const { e, onChange, onSubmit } = setup();
    e.digit(1);
    vi.advanceTimersByTime(1000);
    e.digit(2);
    vi.advanceTimersByTime(1499);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(e.text()).toBe('12');
    vi.advanceTimersByTime(1);
    expect(onSubmit).toHaveBeenCalledWith(12);
    expect(e.text()).toBe('');
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['1', '12', '']);
  });

  it('keeps at most 4 digits', () => {
    const { e, onSubmit } = setup();
    for (const d of [1, 2, 3, 4, 5]) e.digit(d);
    expect(e.text()).toBe('1234');
    vi.advanceTimersByTime(1500);
    expect(onSubmit).toHaveBeenCalledWith(1234);
  });

  it('submit() (Ok) commits right away and reports whether anything was pending', () => {
    const { e, onSubmit } = setup();
    expect(e.submit()).toBe(false);
    e.digit(7);
    expect(e.active()).toBe(true);
    expect(e.submit()).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith(7);
    expect(e.active()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('clear() drops the digits without submitting', () => {
    const { e, onSubmit } = setup();
    e.digit(4);
    e.clear();
    vi.advanceTimersByTime(5000);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(e.text()).toBe('');
  });

  it('reads leading zeros as a plain number', () => {
    const { e, onSubmit } = setup();
    e.digit(0);
    e.digit(7);
    e.submit();
    expect(onSubmit).toHaveBeenCalledWith(7);
  });

  it('ignores invalid digits', () => {
    const { e } = setup();
    e.digit(12);
    e.digit(-1);
    e.digit(1.5);
    expect(e.text()).toBe('');
  });
});
