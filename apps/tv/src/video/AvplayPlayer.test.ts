import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PlayerState, StateDetail } from '@iptv/player';
import {
  AvplayPlayer, avplayDisplay, mapAvplayError,
  type AvplayLike, type AvplayListener, type AvplayTrack,
} from './AvplayPlayer.ts';

const URL_A = 'http://example.test/live/user/pass/1.ts';
const URL_B = 'http://example.test/live/user/pass/2.m3u8';

/** Records every call; the test drives the listener and the prepareAsync callbacks by hand. */
class FakeAvplay implements AvplayLike {
  calls: string[] = [];
  listener: AvplayListener | undefined;
  prepared: { ok: () => void; fail: (e: unknown) => void }[] = [];
  rects: [number, number, number, number][] = [];
  methods: string[] = [];
  time = 0;
  tracks: AvplayTrack[] = [];
  current: AvplayTrack[] = [];
  selected: [string, number][] = [];
  throwOn = new Set<string>();

  private hit(name: string): void {
    this.calls.push(name);
    if (this.throwOn.has(name)) throw Object.assign(new Error('boom'), { name: 'InvalidStateError' });
  }
  open(_url: string): void { this.hit('open'); }
  close(): void { this.hit('close'); }
  prepareAsync(ok?: () => void, fail?: (e: unknown) => void): void {
    this.hit('prepareAsync');
    this.prepared.push({ ok: ok ?? (() => {}), fail: fail ?? (() => {}) });
  }
  play(): void { this.hit('play'); }
  stop(): void { this.hit('stop'); }
  setListener(l: AvplayListener): void { this.hit('setListener'); this.listener = l; }
  setDisplayRect(x: number, y: number, w: number, h: number): void { this.hit('setDisplayRect'); this.rects.push([x, y, w, h]); }
  setDisplayMethod(m: string): void { this.hit('setDisplayMethod'); this.methods.push(m); }
  getCurrentTime(): number { this.hit('getCurrentTime'); return this.time; }
  getTotalTrackInfo(): AvplayTrack[] { this.hit('getTotalTrackInfo'); return this.tracks; }
  setSelectTrack(type: string, i: number): void { this.hit('setSelectTrack'); this.selected.push([type, i]); }
  getCurrentStreamInfo(): AvplayTrack[] { this.hit('getCurrentStreamInfo'); return this.current; }
  buffering: [string, string, number][] = [];
  timeouts: number[] = [];
  props: [string, string][] = [];
  live: Record<string, string> = {};
  seeks: number[] = [];
  still: string[] = [];
  setBufferingParam(o: string, u: string, n: number): void { this.hit('setBufferingParam'); this.buffering.push([o, u, n]); }
  setTimeoutForBuffering(n: number): void { this.hit('setTimeoutForBuffering'); this.timeouts.push(n); }
  setStreamingProperty(t: string, v: string): void { this.hit('setStreamingProperty'); this.props.push([t, v]); }
  getStreamingProperty(t: string): string { this.hit('getStreamingProperty'); return this.live[t] ?? ''; }
  seekTo(ms: number): void { this.hit('seekTo'); this.seeks.push(ms); }
  setVideoStillMode(m: 'true' | 'false'): void { this.hit('setVideoStillMode'); this.still.push(m); }
}

function setup() {
  const av = new FakeAvplay();
  const p = new AvplayPlayer(av);
  const events: [PlayerState, StateDetail | undefined][] = [];
  p.onState((s, d) => events.push([s, d]));
  return { av, p, events };
}

describe('AvplayPlayer: open and listener mapping', () => {
  test('open → loading, then open/setListener/prepareAsync; prepared → play and playing', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 7);
    expect(events).toEqual([['loading', { attemptId: 7 }]]);
    expect(av.calls.slice(0, 2)).toEqual(['open', 'setListener']);
    expect(av.calls).toContain('prepareAsync');
    av.prepared[0]!.ok();
    expect(av.calls.at(-1)).toBe('play');
    expect(events.at(-1)).toEqual(['playing', { attemptId: 7 }]);
  });

  test('buffering start/complete map to buffering/playing once started', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 1);
    av.listener!.onbufferingstart?.();
    av.listener!.onbufferingcomplete?.(); // still preparing: no 'playing' yet
    expect(events.map((e) => e[0])).toEqual(['loading', 'buffering']);
    av.prepared[0]!.ok();
    av.listener!.onbufferingstart?.();
    av.listener!.onbufferingcomplete?.();
    expect(events.map((e) => e[0])).toEqual(['loading', 'buffering', 'playing', 'buffering', 'playing']);
    expect(events.every(([, d]) => d?.attemptId === 1)).toBe(true);
  });

  test('onerror maps the AVPlay error to a code and never puts the URL in the message', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 3);
    av.listener!.onerror?.('PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
    const [state, detail] = events.at(-1)!;
    expect(state).toBe('error');
    expect(detail).toMatchObject({ code: 'UNSUPPORTED', attemptId: 3 });
    expect(JSON.stringify(events)).not.toContain('example.test');
  });

  test('a live stream that completes is reported as a NETWORK error (reconnect)', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A);
    av.prepared[0]!.ok();
    av.listener!.onstreamcompleted?.();
    expect(events.at(-1)).toEqual(['error', { code: 'NETWORK', message: 'Playback error' }]);
  });

  test('prepareAsync failure maps through the error name', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 2);
    av.prepared[0]!.fail({ name: 'PLAYER_ERROR_CONNECTION_FAILED' });
    expect(events.at(-1)).toEqual(['error', { code: 'NETWORK', message: 'Playback error', attemptId: 2 }]);
    expect(av.calls).not.toContain('play');
  });

  test('a throwing open() is caught and reported as an error state', async () => {
    const { av, p, events } = setup();
    av.throwOn.add('open');
    await expect(p.open(URL_A, 4)).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual(['error', { code: 'NETWORK', message: 'Playback error', attemptId: 4 }]);
  });

  test('a throwing play() after prepare is reported, not thrown', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 5);
    av.throwOn.add('play');
    expect(() => av.prepared[0]!.ok()).not.toThrow();
    expect(events.at(-1)?.[0]).toBe('error');
  });

  test('without an attemptId no attemptId is added', async () => {
    const { p, events } = setup();
    await p.open(URL_A);
    expect(events).toEqual([['loading', {}]]);
  });
});

describe('AvplayPlayer: stale events', () => {
  test('stop() calls avplay.stop() then close(), and drops later events of that stream', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 1);
    const old = av.listener!;
    const prep = av.prepared[0]!;
    av.calls = [];
    p.stop();
    expect(av.calls).toEqual(['stop', 'close']);
    old.onbufferingstart?.();
    old.onerror?.('PLAYER_ERROR_CONNECTION_FAILED');
    prep.ok();
    expect(events).toEqual([['loading', { attemptId: 1 }]]);
    expect(av.calls).not.toContain('play');
  });

  test('a new open() stops the old stream; old listener and prepare callbacks stay silent', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 1);
    const oldListener = av.listener!;
    const oldPrep = av.prepared[0]!;
    await p.open(URL_B, 2);
    expect(av.calls.filter((c) => c === 'stop' || c === 'close')).toEqual(['stop', 'close']);
    oldListener.onerror?.('PLAYER_ERROR_CONNECTION_FAILED');
    oldPrep.ok();
    av.prepared[1]!.ok();
    expect(events).toEqual([
      ['loading', { attemptId: 1 }],
      ['loading', { attemptId: 2 }],
      ['playing', { attemptId: 2 }],
    ]);
  });

  test('stop() survives throwing stop/close and still closes', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.throwOn.add('stop');
    av.calls = [];
    expect(() => p.stop()).not.toThrow();
    expect(av.calls).toEqual(['stop', 'close']);
  });

  test('stop() without a stream does nothing; destroy stops and clears listeners', async () => {
    const { av, p, events } = setup();
    p.stop();
    expect(av.calls).toEqual([]);
    await p.open(URL_A, 1);
    const l = av.listener!;
    p.destroy();
    expect(av.calls.slice(-2)).toEqual(['stop', 'close']);
    l.onbufferingstart?.();
    expect(events).toHaveLength(1);
  });
});

describe('AvplayPlayer: position, tracks and stream info', () => {
  test('position() uses getCurrentTime and falls back to the last value when it throws', async () => {
    const { av, p } = setup();
    expect(p.position()).toBe(0); // no stream: no call
    await p.open(URL_A);
    av.time = 1500;
    expect(p.position()).toBe(1500);
    av.throwOn.add('getCurrentTime');
    expect(p.position()).toBe(1500);
  });

  test('audio tracks come from getTotalTrackInfo; the active one from getCurrentStreamInfo', async () => {
    const { av, p } = setup();
    av.tracks = [
      { index: 0, type: 'VIDEO', extra_info: '{"fourCC":"H264","Width":"1920","Height":"1080"}' },
      { index: 1, type: 'AUDIO', extra_info: '{"language":"eng","fourCC":"AAC"}' },
      { index: 2, type: 'AUDIO', extra_info: 'not json' },
    ];
    av.current = [{ index: 2, type: 'AUDIO', extra_info: '' }];
    expect(p.audioTracks()).toEqual([]); // no stream yet
    await p.open(URL_A);
    expect(p.audioTracks()).toEqual([
      { id: '1', label: 'eng', language: 'eng', active: false },
      { id: '2', label: 'Track 2', active: true },
    ]);
    p.selectAudioTrack('1');
    expect(av.selected).toEqual([['AUDIO', 1]]);
    p.selectAudioTrack('0'); // a video track: ignored
    p.selectAudioTrack('x');
    expect(av.selected).toEqual([['AUDIO', 1]]);
    av.throwOn.add('getTotalTrackInfo');
    expect(p.audioTracks()).toEqual([]);
  });

  test('streamInfo parses the current video and audio tracks', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.current = [
      { index: 0, type: 'VIDEO', extra_info: '{"fourCC":"H264","Width":"1280","Height":"720","Bit_rate":"3000000"}' },
      { index: 1, type: 'AUDIO', extra_info: '{"fourCC":"AAC"}' },
    ];
    expect(p.streamInfo()).toEqual({ width: 1280, height: 720, videoCodec: 'H264', audioCodec: 'AAC', bitrate: 3000000 });
    av.throwOn.add('getCurrentStreamInfo');
    expect(p.streamInfo()).toEqual({});
  });

  test('currentUrl() is the URL in flight, gone after stop', async () => {
    const { p } = setup();
    await p.open(URL_A);
    expect(p.currentUrl()).toBe(URL_A);
    p.stop();
    expect(p.currentUrl()).toBeUndefined();
  });
});

describe('AvplayPlayer: display rect and aspect', () => {
  test('setRect/setAspect before open are applied when the stream opens', async () => {
    const { av, p } = setup();
    p.setRect({ x: 96, y: 54, w: 480, h: 270 });
    expect(av.calls).toEqual([]);
    await p.open(URL_A);
    expect(av.rects.at(-1)).toEqual([96, 54, 480, 270]);
    expect(av.methods.at(-1)).toBe('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');
  });

  test('setRect while open moves the video; fullscreen is the whole screen', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    p.setRect('fullscreen');
    expect(av.rects.at(-1)).toEqual([0, 0, 1920, 1080]);
    p.setRect({ x: 10, y: 20, w: 300, h: 200 });
    expect(av.rects.at(-1)).toEqual([10, 20, 300, 200]);
  });

  test('aspect modes map to display methods', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    p.setAspect('stretch');
    expect(av.methods.at(-1)).toBe('PLAYER_DISPLAY_MODE_FULL_SCREEN');
    p.setAspect('4:3');
    expect(av.methods.at(-1)).toBe('PLAYER_DISPLAY_MODE_FULL_SCREEN');
    expect(av.rects.at(-1)).toEqual([240, 0, 1440, 1080]);
    p.setAspect('zoom');
    expect(av.methods.at(-1)).toBe('PLAYER_DISPLAY_MODE_LETTER_BOX');
    p.setAspect('auto');
    expect(av.methods.at(-1)).toBe('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');
    expect(av.rects.at(-1)).toEqual([0, 0, 1920, 1080]);
  });

  test('a throwing setDisplayRect is swallowed', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.throwOn.add('setDisplayRect');
    expect(() => p.setRect('fullscreen')).not.toThrow();
  });

  test('the display space is converted from design space (1920x1080)', async () => {
    const av = new FakeAvplay();
    const p = new AvplayPlayer(av, { displaySpace: { w: 3840, h: 2160 } });
    p.setRect({ x: 96, y: 54, w: 480, h: 270 });
    await p.open(URL_A);
    expect(av.rects.at(-1)).toEqual([192, 108, 960, 540]);
  });
});

describe('avplayDisplay (pure)', () => {
  const space = { w: 1920, h: 1080 };
  const full = { x: 0, y: 0, w: 1920, h: 1080 };
  test('auto and stretch keep the rect', () => {
    expect(avplayDisplay(full, 'auto', space)).toEqual({ x: 0, y: 0, w: 1920, h: 1080, method: 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO' });
    expect(avplayDisplay(full, 'stretch', space)).toEqual({ x: 0, y: 0, w: 1920, h: 1080, method: 'PLAYER_DISPLAY_MODE_FULL_SCREEN' });
  });
  test('16:9 in a 4:3 rect is a centred, contained 16:9 box', () => {
    expect(avplayDisplay({ x: 0, y: 0, w: 1440, h: 1080 }, '16:9', space))
      .toEqual({ x: 0, y: 135, w: 1440, h: 810, method: 'PLAYER_DISPLAY_MODE_FULL_SCREEN' });
  });
  test('zoom covers the rect with the source aspect (crops the overflow)', () => {
    // A 4:3 source zoomed to fill a 16:9 screen: full width, taller than the screen, centred.
    expect(avplayDisplay(full, 'zoom', space, 4 / 3))
      .toEqual({ x: 0, y: -180, w: 1920, h: 1440, method: 'PLAYER_DISPLAY_MODE_LETTER_BOX' });
    // Unknown source aspect: assume 16:9, so a 16:9 rect is unchanged.
    expect(avplayDisplay(full, 'zoom', space)).toEqual({ x: 0, y: 0, w: 1920, h: 1080, method: 'PLAYER_DISPLAY_MODE_LETTER_BOX' });
  });
  test('zoom in a preview rect falls back to auto (no spill outside the box)', () => {
    const preview = { x: 100, y: 100, w: 640, h: 360 };
    expect(avplayDisplay(preview, 'zoom', space, 4 / 3))
      .toEqual({ x: 100, y: 100, w: 640, h: 360, method: 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO' });
  });
  test('converts to another display space and rounds', () => {
    expect(avplayDisplay({ x: 1, y: 1, w: 3, h: 3 }, 'auto', { w: 1280, h: 720 }))
      .toEqual({ x: 1, y: 1, w: 2, h: 2, method: 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO' });
  });
});

describe('mapAvplayError (pure)', () => {
  test.each([
    ['PLAYER_ERROR_NOT_SUPPORTED_FILE', 'UNSUPPORTED'],
    ['PLAYER_ERROR_NOT_SUPPORTED_FORMAT', 'UNSUPPORTED'],
    ['PLAYER_ERROR_DRM_NOT_PERMITTED', 'UNSUPPORTED'],
    ['NotSupportedError', 'UNSUPPORTED'],
    ['PLAYER_ERROR_CONNECTION_FAILED', 'NETWORK'],
    ['PLAYER_ERROR_INVALID_URI', 'NETWORK'],
    ['PLAYER_ERROR_NO_SUCH_FILE', 'NETWORK'],
    ['PLAYER_ERROR_TIMED_OUT', 'NETWORK'],
    ['PLAYER_ERROR_INVALID_STATE', 'MEDIA'],
    ['PLAYER_ERROR_GENEREIC', 'MEDIA'],
  ])('%s → %s', (name, code) => {
    expect(mapAvplayError(name)).toBe(code);
    expect(mapAvplayError({ name })).toBe(code);
  });
  test('unknown shapes are NETWORK (retryable)', () => {
    expect(mapAvplayError(undefined)).toBe('NETWORK');
    expect(mapAvplayError({})).toBe('NETWORK');
  });
});

describe('AvplayPlayer: live delay and recovery', () => {
  test('applies the preset buffering before prepareAsync; a throwing call is ignored', async () => {
    const { av, p } = setup();
    p.setLiveProfile({ preset: 'stable', targetS: 6, allowRate: false });
    av.throwOn.add('setTimeoutForBuffering');
    await p.open(URL_A, 1);
    expect(av.buffering).toEqual([
      ['PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 6],
      ['PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', 10],
    ]);
    expect(av.props).toContainEqual(['ADAPTIVE_INFO', 'STARTBITRATE=LOWEST']);
    expect(av.calls.indexOf('setBufferingParam')).toBeLessThan(av.calls.indexOf('prepareAsync'));
    expect(av.calls).toContain('prepareAsync');
  });

  describe('prepare watchdog', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    test('reports NETWORK when neither prepare callback arrives in time', async () => {
      const av = new FakeAvplay();
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const events: [PlayerState, StateDetail | undefined][] = [];
      p.onState((s, d) => events.push([s, d]));
      await p.open(URL_A, 2);
      vi.advanceTimersByTime(999);
      expect(events.at(-1)?.[0]).toBe('loading');
      vi.advanceTimersByTime(1);
      expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', attemptId: 2 })]);
    });

    test('a prepared stream cancels the watchdog', async () => {
      const av = new FakeAvplay();
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const events: PlayerState[] = [];
      p.onState((s) => events.push(s));
      await p.open(URL_A);
      av.prepared[0]!.ok();
      vi.advanceTimersByTime(5000);
      expect(events).toEqual(['loading', 'playing']);
    });
  });

  test('health and seekToLive use the live window', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '1', GET_LIVE_DURATION: '100000|160000' };
    av.time = 140_000;
    expect(p.health()).toEqual({ positionMs: 140_000, behindLiveS: 20, behindLiveSource: 'edge' });
    expect(p.seekToLive(6)).toBe(true);
    expect(av.seeks).toEqual([154_000]);
  });

  test('no live window: health has only the position, seekToLive is false', async () => {
    const { av, p } = setup();
    await p.open(URL_B);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '0' };
    expect(p.health()).toEqual({ positionMs: 0 });
    expect(p.seekToLive(6)).toBe(false);
  });

  test('holdLastFrame turns still mode on until the next stream plays', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.prepared[0]!.ok();
    p.holdLastFrame();
    await p.open(URL_B);
    expect(av.still).toEqual(['true']);
    av.prepared[1]!.ok();
    expect(av.still).toEqual(['true', 'false']);
  });
});
