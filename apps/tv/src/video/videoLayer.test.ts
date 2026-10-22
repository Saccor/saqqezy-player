import { describe, expect, it } from 'vitest';
import { createSlotRoot } from './videoLayer.ts';

describe('createSlotRoot', () => {
  it('adds a video root for slot n right after the main one, styled like it', () => {
    const made: Array<{ className: string; dataset: Record<string, string> }> = [];
    const after: unknown[] = [];
    const root = {
      ownerDocument: { createElement: () => { const el = { className: '', dataset: {} }; made.push(el); return el; } },
      after: (el: unknown) => { after.push(el); },
    } as unknown as HTMLElement;
    const el = createSlotRoot(root, 2);
    expect(made).toEqual([{ className: 'video-slot', dataset: { slot: '2' } }]);
    expect(after).toEqual([el]);
  });
});
