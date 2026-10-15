import { describe, expect, it, vi } from 'vitest';
import { notifyUserGesture, onUserGesture } from './keys.ts';

describe('notifyUserGesture', () => {
  it('calls every gesture listener (the mouse gives the sound back like a key does), even when one throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const offA = onUserGesture(() => { throw new TypeError('boom'); });
    const offB = onUserGesture(() => { seen.push('b'); });
    notifyUserGesture();
    expect(seen).toEqual(['b']);
    expect(error).toHaveBeenCalledWith('Gesture handler failed', 'TypeError');
    offA();
    offB();
    notifyUserGesture();
    expect(seen).toEqual(['b']);
    error.mockRestore();
  });
});
