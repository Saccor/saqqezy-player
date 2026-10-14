import { describe, expect, it } from 'vitest';
import { inertWhileOpen } from './modal.ts';

describe('inertWhileOpen', () => {
  it('makes the background inert while the dialog is open and restores it afterwards', () => {
    const shell = { inert: false };
    const release = inertWhileOpen([shell]);
    expect(shell.inert).toBe(true);
    release();
    expect(shell.inert).toBe(false);
  });

  it('leaves an element that was already inert inert, skips missing ones, and releases once', () => {
    const already = { inert: true };
    const shell = { inert: false };
    const release = inertWhileOpen([already, null, undefined, shell]);
    release();
    expect(already.inert).toBe(true);
    expect(shell.inert).toBe(false);
    shell.inert = true; // something else made it inert later
    release();
    expect(shell.inert).toBe(true);
  });
});
