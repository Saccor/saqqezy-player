import { expect, test, vi } from 'vitest';

// hls.js and mpegts.js are over half of the app bundle; Samsung TVs play through AVPlay and never need them.
const loaded = vi.hoisted(() => ({ hls: false, mpegts: false }));

vi.mock('hls.js', () => {
  loaded.hls = true;
  return { default: class { static isSupported = () => true; static Events = {}; }, ErrorDetails: {}, ErrorTypes: {} };
});
vi.mock('mpegts.js', () => {
  loaded.mpegts = true;
  return { default: { isSupported: () => true, Events: {}, ErrorDetails: {}, ErrorTypes: {} } };
});

test('importing the HTML5 player loads neither MSE engine', async () => {
  await import('./Html5Player.ts');
  expect(loaded).toEqual({ hls: false, mpegts: false });
});

test('loadMseEngines loads both engines once', async () => {
  const { loadMseEngines } = await import('./Html5Player.ts');
  const a = await loadMseEngines();
  const b = await loadMseEngines();
  expect(loaded).toEqual({ hls: true, mpegts: true });
  expect(a).toBe(b);
});
