import { describe, expect, it } from 'vitest';
import { createChannelHistory } from './channelHistory.ts';

describe('createChannelHistory', () => {
  it('tracks the previously watched channel', () => {
    const h = createChannelHistory();
    expect(h.previous()).toBeUndefined();
    h.visit('a');
    expect(h.current()).toBe('a');
    expect(h.previous()).toBeUndefined();
    h.visit('b');
    expect(h.previous()).toBe('a');
    h.visit('c');
    expect(h.previous()).toBe('b');
  });

  it('revisiting the current channel keeps the previous one', () => {
    const h = createChannelHistory();
    h.visit('a');
    h.visit('b');
    h.visit('b');
    expect(h.previous()).toBe('a');
  });

  it('toggling swaps current and previous', () => {
    const h = createChannelHistory();
    h.visit('a');
    h.visit('b');
    h.visit(h.previous()!);
    expect(h.current()).toBe('a');
    expect(h.previous()).toBe('b');
    h.visit(h.previous()!);
    expect(h.current()).toBe('b');
    expect(h.previous()).toBe('a');
  });
});
