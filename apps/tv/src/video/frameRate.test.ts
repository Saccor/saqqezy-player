import { describe, expect, it } from 'vitest';
import { fpsFromSamples, fpsFromTrackExtra, median, snapFps, type FrameSample } from './frameRate.ts';

/** `n` callbacks one frame apart at `fps`. */
const frames = (fps: number, n: number, from = 0): FrameSample[] =>
  Array.from({ length: n }, (_, i) => ({ mediaTime: 10 + i / fps, presentedFrames: from + i }));

describe('snapFps', () => {
  it('snaps within 1% to a common rate', () => {
    expect(snapFps(23.98)).toBe(23.976);
    expect(snapFps(24.05)).toBe(24);
    expect(snapFps(25.2)).toBe(25);
    expect(snapFps(29.97)).toBe(29.97);
    expect(snapFps(59.9)).toBe(59.94);
    expect(snapFps(50)).toBe(50);
  });

  it('nothing near a common rate, or nonsense: unknown', () => {
    expect(snapFps(27)).toBeUndefined();
    expect(snapFps(12.5)).toBeUndefined();
    expect(snapFps(0)).toBeUndefined();
    expect(snapFps(Number.NaN)).toBeUndefined();
    expect(snapFps(undefined)).toBeUndefined();
  });
});

describe('median', () => {
  it('middle value, mean of the two middle ones, none for empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe('fpsFromSamples', () => {
  it('a steady stream of frames: its rate', () => {
    expect(fpsFromSamples(frames(25, 25))).toBe(25);
    expect(fpsFromSamples(frames(24000 / 1001, 24))).toBe(23.976);
    expect(fpsFromSamples(frames(60000 / 1001, 60))).toBe(59.94);
  });

  it('dropped frames and a jump are left out (only single-frame steps count)', () => {
    const s = frames(25, 20);
    // A dropped frame: two frames presented between callbacks.
    s.splice(10, 1);
    // A seek: media time jumps.
    s.push({ mediaTime: 500, presentedFrames: (s.at(-1)?.presentedFrames ?? 0) + 1 });
    s.push({ mediaTime: 500.04, presentedFrames: (s.at(-1)?.presentedFrames ?? 0) + 1 });
    expect(fpsFromSamples(s)).toBe(25);
  });

  it('too few steps or an uncommon rate: unknown', () => {
    expect(fpsFromSamples(frames(25, 4))).toBeUndefined();
    expect(fpsFromSamples(frames(27, 30))).toBeUndefined();
    expect(fpsFromSamples([])).toBeUndefined();
    // Callbacks with no new frame (paused) give no steps.
    expect(fpsFromSamples(Array.from({ length: 10 }, () => ({ mediaTime: 1, presentedFrames: 5 })))).toBeUndefined();
  });
});

describe('fpsFromTrackExtra', () => {
  const extra = (s: string) => JSON.parse(s) as Record<string, unknown>;

  it('reads a frame rate key in any of the usual spellings and forms', () => {
    expect(fpsFromTrackExtra(extra('{"fourCC":"H264","Width":"1920","Height":"1080","Bit_rate":"5000000","fps":"25"}'))).toBe(25);
    expect(fpsFromTrackExtra(extra('{"FrameRate":"23.976"}'))).toBe(23.976);
    expect(fpsFromTrackExtra(extra('{"framerate":23976}'))).toBe(23.976);
    expect(fpsFromTrackExtra(extra('{"frame_rate":"30000/1001"}'))).toBe(29.97);
    expect(fpsFromTrackExtra(extra('{"Framerate":"12.5"}'))).toBe(12.5);
  });

  it('missing, empty or nonsense: unknown', () => {
    expect(fpsFromTrackExtra(extra('{"fourCC":"H264","Width":"1920","Height":"1080"}'))).toBeUndefined();
    expect(fpsFromTrackExtra(extra('{"fps":""}'))).toBeUndefined();
    expect(fpsFromTrackExtra(extra('{"fps":"0"}'))).toBeUndefined();
    expect(fpsFromTrackExtra(extra('{"fps":"abc"}'))).toBeUndefined();
    // A large number is thousandths only when that is a standard rate.
    expect(fpsFromTrackExtra(extra('{"fps":"25000"}'))).toBe(25);
    expect(fpsFromTrackExtra(extra('{"fps":"12500"}'))).toBeUndefined();
    expect(fpsFromTrackExtra(extra('{"fps":"500"}'))).toBeUndefined();
    expect(fpsFromTrackExtra({})).toBeUndefined();
  });
});
