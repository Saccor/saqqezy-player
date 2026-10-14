import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

/** Every hls.js / mpegts.js instance the player creates, with the calls made on it. */
const created = vi.hoisted(() => ({
  hls: [] as { calls: string[] }[],
  mpegts: [] as { calls: string[]; error?: (type: string, detail: string) => void }[],
}));

vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError' };
    calls: string[] = [];
    audioTracks = [];
    levels = [];
    constructor() { created.hls.push(this); }
    on(): void { this.calls.push('on'); }
    loadSource(): void { this.calls.push('loadSource'); }
    attachMedia(): void { this.calls.push('attachMedia'); }
    detachMedia(): void { this.calls.push('detachMedia'); }
    destroy(): void { this.calls.push('destroy'); }
  }
  return {
    default: FakeHls,
    ErrorDetails: {
      MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'a', BUFFER_ADD_CODEC_ERROR: 'b', BUFFER_INCOMPATIBLE_CODECS_ERROR: 'c',
      MANIFEST_PARSING_ERROR: 'd',
    },
    ErrorTypes: { NETWORK_ERROR: 'networkError' },
  };
});

vi.mock('mpegts.js', () => ({
  default: {
    isSupported: () => true,
    Events: { ERROR: 'error' },
    ErrorTypes: { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError' },
    ErrorDetails: {
      MEDIA_FORMAT_ERROR: 'FormatError', MEDIA_FORMAT_UNSUPPORTED: 'FormatUnsupported',
      MEDIA_CODEC_UNSUPPORTED: 'CodecUnsupported',
    },
    createPlayer: () => {
      const p = {
        calls: [] as string[],
        error: undefined as ((type: string, detail: string) => void) | undefined,
        on(_e: string, fn: (type: string, detail: string) => void) { p.error = fn; },
        attachMediaElement() { p.calls.push('attach'); },
        load() { p.calls.push('load'); },
        pause() { p.calls.push('pause'); },
        unload() { p.calls.push('unload'); },
        detachMediaElement() { p.calls.push('detach'); },
        destroy() { p.calls.push('destroy'); },
      };
      created.mpegts.push(p);
      return p;
    },
  },
}));

const { Html5Player } = await import('./Html5Player.ts');

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ['self', 'location', 'navigator']) saved[k] = g[k];
  const location = { href: 'http://app.test/', origin: 'http://app.test' };
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
});
afterAll(() => {
  for (const k of Object.keys(saved)) Object.defineProperty(globalThis, k, { value: saved[k], configurable: true, writable: true });
});

function fakeVideo() {
  return {
    readyState: 0,
    error: null,
    muted: false,
    addEventListener() {},
    removeEventListener() {},
    canPlayType: () => '',
    play: () => Promise.resolve(),
    pause() {},
    load() {},
    removeAttribute() {},
  };
}

describe('Html5Player – mpegts.js to HLS retry', () => {
  test('the engine switch runs after the mpegts.js ERROR callback has returned, not inside it', async () => {
    const video = fakeVideo();
    const layer = { video, setRect() {}, setAspect() {}, relayout() {}, destroy() {} };
    const player = new Html5Player(layer as unknown as ConstructorParameters<typeof Html5Player>[0]);
    const states: string[] = [];
    player.onState((s) => states.push(s));
    await player.open('http://example.test/live/u/p/1');
    const ts = created.mpegts.at(-1)!;
    expect(created.hls).toHaveLength(0);

    ts.error!('MediaError', 'FormatError');
    // Still inside (or right after) the callback: nothing torn down or started yet.
    expect(ts.calls).not.toContain('destroy');
    expect(created.hls).toHaveLength(0);
    expect(states).not.toContain('error');
    // A second error from the same, now abandoned, instance is ignored.
    ts.error!('MediaError', 'FormatError');

    await new Promise((r) => setTimeout(r, 0));
    expect(ts.calls).toContain('destroy');
    expect(created.hls).toHaveLength(1);
    expect(created.hls[0]!.calls).toEqual(expect.arrayContaining(['loadSource', 'attachMedia']));
    expect(states).not.toContain('error');
    player.destroy();
  });

  test('a stop before the deferred switch still tears the mpegts.js instance down and starts nothing', async () => {
    const video = fakeVideo();
    const layer = { video, setRect() {}, setAspect() {}, relayout() {}, destroy() {} };
    const player = new Html5Player(layer as unknown as ConstructorParameters<typeof Html5Player>[0]);
    await player.open('http://example.test/live/u/p/2');
    const ts = created.mpegts.at(-1)!;
    const hlsBefore = created.hls.length;
    ts.error!('MediaError', 'FormatError');
    player.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(ts.calls).toContain('destroy');
    expect(created.hls).toHaveLength(hlsBefore);
  });
});
