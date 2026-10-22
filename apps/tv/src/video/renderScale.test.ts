import { describe, expect, test } from 'vitest';
import { renderPixelRatios, rendererTuning } from './renderScale.ts';

const win = (innerWidth: number, innerHeight: number, devicePixelRatio: number) => ({ innerWidth, innerHeight, devicePixelRatio });
/** Canvas buffer width the renderer allocates: appWidth × logical × physical. */
const bufferWidth = (r: { logical: number; physical: number }) => Math.round(1920 * r.logical * r.physical);

describe('renderPixelRatios', () => {
  test('a 1080p TV draws at 1920x1080, as before', () => {
    expect(renderPixelRatios('tizen', win(1920, 1080, 1))).toEqual({ logical: 1, physical: 1 });
  });

  test('a TV with a 1440p graphics plane (pixel ratio 1.33) still draws a 1920-wide buffer', () => {
    const r = renderPixelRatios('tizen', win(1920, 1080, 4 / 3));
    expect(r.logical).toBe(1);
    expect(bufferWidth(r)).toBe(1920);
  });

  test('a TV with a 2560x1440 viewport keeps the canvas full size in CSS but draws 1920 wide', () => {
    const r = renderPixelRatios('tizen', win(2560, 1440, 1));
    expect(r.logical).toBeCloseTo(4 / 3);
    expect(bufferWidth(r)).toBe(1920);
  });

  test('webOS is capped the same way', () => {
    expect(bufferWidth(renderPixelRatios('webos', win(1920, 1080, 2)))).toBe(1920);
  });

  test('a smaller TV viewport is never supersampled', () => {
    const r = renderPixelRatios('tizen', win(1280, 720, 1));
    expect(bufferWidth(r)).toBe(1280);
  });

  test('desktop and browser keep full device sharpness', () => {
    expect(renderPixelRatios('browser', win(1920, 1080, 2))).toEqual({ logical: 1, physical: 2 });
    expect(bufferWidth(renderPixelRatios('desktop', win(2560, 1440, 1.5)))).toBe(3840);
  });

  test('a missing or zero pixel ratio counts as 1', () => {
    expect(renderPixelRatios('browser', win(1920, 1080, 0))).toEqual({ logical: 1, physical: 1 });
  });
});

describe('rendererTuning', () => {
  test('TVs spread texture uploads over frames and preload a 200 px margin', () => {
    expect(rendererTuning('tizen')).toEqual({ boundsMargin: 200, textureProcessingTimeLimit: 10 });
    expect(rendererTuning('webos')).toEqual({ boundsMargin: 200, textureProcessingTimeLimit: 10 });
  });

  test('desktop and browser keep the renderer defaults', () => {
    expect(rendererTuning('browser')).toEqual({});
    expect(rendererTuning('desktop')).toEqual({});
  });
});
