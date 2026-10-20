import { describe, expect, it } from 'vitest';
import { onHidden, onVisible } from './backgroundPolicy.ts';

describe('backgroundPolicy', () => {
  it('nothing playing → none / none', () => {
    const b = onHidden({ playing: 'none' });
    expect(b).toEqual({ kind: 'none' });
    expect(onVisible(b, { networkUp: true })).toEqual({ kind: 'none' });
  });
  it('live → close on hidden, reopen on visible', () => {
    const b = onHidden({ playing: 'live' });
    expect(b).toEqual({ kind: 'close-live' });
    expect(onVisible(b, { networkUp: true })).toEqual({ kind: 'reopen-live' });
  });
  it('live with the network still down → wait-network', () => {
    expect(onVisible({ kind: 'close-live' }, { networkUp: false })).toEqual({ kind: 'wait-network' });
  });
  it('vod → suspend at the position, resume at the same position', () => {
    const b = onHidden({ playing: 'vod', positionMs: 61_000 });
    expect(b).toEqual({ kind: 'suspend-vod', positionMs: 61_000 });
    expect(onVisible(b, { networkUp: true })).toEqual({ kind: 'resume-vod', positionMs: 61_000 });
  });
  it('vod not playing yet (loading, reconnecting) → close at the position, reopen there on visible', () => {
    const b = onHidden({ playing: 'vod-loading', positionMs: 30_000 });
    expect(b).toEqual({ kind: 'close-vod', positionMs: 30_000 });
    expect(onVisible(b, { networkUp: true })).toEqual({ kind: 'reopen-vod', positionMs: 30_000 });
  });
  it('vod with unknown position → 0', () => {
    expect(onHidden({ playing: 'vod' })).toEqual({ kind: 'suspend-vod', positionMs: 0 });
  });
});
