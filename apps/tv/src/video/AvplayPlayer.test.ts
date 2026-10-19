import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Player, PlayerState, StateDetail } from '@iptv/player';
import {
  AvplayPlayer, avplayDisplay, avplayErrorName, mapAvplayError,
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
  seekCbs: { ok: () => void; fail: (e: unknown) => void }[] = [];
  seekTo(ms: number, ok?: () => void, fail?: (e: unknown) => void): void {
    this.hit('seekTo');
    this.seeks.push(ms);
    this.seekCbs.push({ ok: ok ?? (() => {}), fail: fail ?? (() => {}) });
  }
  setVideoStillMode(m: 'true' | 'false'): void { this.hit('setVideoStillMode'); this.still.push(m); }
  state = 'IDLE';
  durationMs = 0;
  silent: boolean[] = [];
  pause(): void { this.hit('pause'); }
  getState(): string { this.hit('getState'); return this.state; }
  getDuration(): number { this.hit('getDuration'); return this.durationMs; }
  setSilentSubtitle(on: boolean): void { this.hit('setSilentSubtitle'); this.silent.push(on); }
  restores: [string, number, boolean][] = [];
  suspend(): void { this.hit('suspend'); }
  restore(url: string, ms: number, prepare: boolean): void { this.hit('restore'); this.restores.push([url, ms, prepare]); }
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
    av.live = { IS_LIVE: '1' };
    av.listener!.onstreamcompleted?.();
    expect(events.at(-1)).toEqual(['error', { code: 'NETWORK', message: 'Playback error', detail: 'streamCompleted' }]);
  });

  test('prepareAsync failure maps through the error name', async () => {
    const { av, p, events } = setup();
    await p.open(URL_A, 2);
    av.prepared[0]!.fail({ name: 'PLAYER_ERROR_CONNECTION_FAILED' });
    expect(events.at(-1)).toEqual(['error', { code: 'NETWORK', message: 'Playback error', attemptId: 2, detail: 'PLAYER_ERROR_CONNECTION_FAILED' }]);
    expect(av.calls).not.toContain('play');
  });

  test('a throwing open() is caught and reported as an error state', async () => {
    const { av, p, events } = setup();
    av.throwOn.add('open');
    await expect(p.open(URL_A, 4)).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual(['error', { code: 'NETWORK', message: 'Playback error', attemptId: 4, detail: 'InvalidStateError' }]);
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
      { id: '1', label: 'eng', language: 'eng', codec: 'aac', active: false },
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

    test('prepareAsync throwing synchronously reports one error and the watchdog stays quiet', async () => {
      const av = new FakeAvplay();
      av.throwOn.add('prepareAsync');
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const events: PlayerState[] = [];
      p.onState((s) => events.push(s));
      await p.open(URL_A, 3);
      vi.advanceTimersByTime(5000);
      expect(events.filter((s) => s === 'error')).toHaveLength(1);
    });

    test('onerror before prepare reports one error; the watchdog does not add a second', async () => {
      const av = new FakeAvplay();
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const events: PlayerState[] = [];
      p.onState((s) => events.push(s));
      await p.open(URL_A, 4);
      av.listener!.onerror!('PLAYER_ERROR_CONNECTION_FAILED');
      vi.advanceTimersByTime(5000);
      expect(events.filter((s) => s === 'error')).toHaveLength(1);
    });

    test('onstreamcompleted before prepare reports one error only', async () => {
      const av = new FakeAvplay();
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const events: PlayerState[] = [];
      p.onState((s) => events.push(s));
      await p.open(URL_A, 5);
      av.listener!.onstreamcompleted!();
      vi.advanceTimersByTime(5000);
      expect(events.filter((s) => s === 'error')).toHaveLength(1);
    });

    test('opening B before A prepares: A never reports an error', async () => {
      const av = new FakeAvplay();
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const errors: (number | undefined)[] = [];
      p.onState((s, d) => { if (s === 'error') errors.push(d?.attemptId); });
      await p.open(URL_A, 10);
      vi.advanceTimersByTime(500);
      await p.open(URL_B, 11);
      vi.advanceTimersByTime(5000);
      expect(errors).not.toContain(10);
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
    expect(p.health()).toEqual({ engine: 'avplay', positionMs: 140_000, behindLiveS: 20, behindLiveSource: 'edge', isLive: true });
    expect(p.seekToLive(6)).toBe(true);
    expect(av.seeks).toEqual([154_000]);
  });

  test('live without a window: no delay in health, seekToLive is false (the caller reopens)', async () => {
    const { av, p } = setup();
    await p.open(URL_B);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '1' };
    expect(p.health()).toEqual({ engine: 'avplay', positionMs: 0, isLive: true });
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

  test('a live window missing before the stream started is not cached', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    expect(p.health()).toEqual({ engine: 'avplay', positionMs: 0 });
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '1', GET_LIVE_DURATION: '100000|160000' };
    av.time = 150_000;
    expect(p.health()).toEqual({ engine: 'avplay', positionMs: 150_000, behindLiveS: 10, behindLiveSource: 'edge', isLive: true });
  });

  test('destroy releases a held still frame', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.prepared[0]!.ok();
    p.holdLastFrame();
    p.destroy();
    expect(av.still).toEqual(['true', 'false']);
  });
});

describe('AvplayPlayer: final fixes', () => {
  test('1a: isLive from IS_LIVE: true when set, false when falsy once started, unknown on error', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '1', GET_LIVE_DURATION: '100000|160000' };
    av.time = 140_000;
    expect(p.health()).toMatchObject({ isLive: true });

    const vod = setup();
    await vod.p.open(URL_B);
    vod.av.prepared[0]!.ok();
    vod.av.live = { IS_LIVE: '0' };
    expect(vod.p.health()).toEqual({ engine: 'avplay', positionMs: 0, isLive: false });

    const broken = setup();
    await broken.p.open(URL_B);
    broken.av.prepared[0]!.ok();
    broken.av.throwOn.add('getStreamingProperty');
    expect(broken.p.health()).toEqual({ engine: 'avplay', positionMs: 0 });
  });

  test('1f: a non-live stream that completes reports idle, never a reconnect-triggering error', async () => {
    const { av, p, events } = setup();
    await p.open(URL_B, 3);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '0' };
    av.listener!.onstreamcompleted?.();
    expect(events.at(-1)).toEqual(['idle', { attemptId: 3 }]);
    expect(events.some(([s]) => s === 'error')).toBe(false);
  });

  test('1g: seekToLive is a no-op (true) on a non-live stream', async () => {
    const { av, p } = setup();
    await p.open(URL_B);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '0' };
    expect(p.seekToLive(6)).toBe(true);
    expect(av.seeks).toEqual([]);
  });
});

describe('AvplayPlayer: diagnostics', () => {
  test('health() names the engine', async () => {
    const { p } = setup();
    await p.open(URL_A);
    expect(p.health().engine).toBe('avplay');
  });

  test('avplayErrorName reads a string or an error name, else empty', () => {
    expect(avplayErrorName('PLAYER_ERROR_CONNECTION_FAILED')).toBe('PLAYER_ERROR_CONNECTION_FAILED');
    expect(avplayErrorName({ name: 'NotSupportedError' })).toBe('NotSupportedError');
    expect(avplayErrorName(42)).toBe('');
  });

  test('the prepare watchdog reports prepareTimeout', async () => {
    vi.useFakeTimers();
    try {
      const av = new FakeAvplay();
      const p = new AvplayPlayer(av, { prepareTimeoutMs: 1000 });
      const events: [PlayerState, StateDetail | undefined][] = [];
      p.onState((s, d) => events.push([s, d]));
      await p.open(URL_A);
      vi.advanceTimersByTime(1000);
      expect(events.at(-1)).toEqual(['error', expect.objectContaining({ code: 'NETWORK', detail: 'prepareTimeout' })]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AvplayPlayer: VOD controls', () => {
  test('a VOD open with startMs seeks after prepare and plays once the seek lands', async () => {
    const { av, p, events } = setup();
    await p.open(URL_B, 8, { live: false, startMs: 90_000 });
    av.prepared[0]!.ok();
    expect(av.seeks).toEqual([90_000]);
    expect(av.calls).not.toContain('play');
    expect(events.map((e) => e[0])).toEqual(['loading']);
    av.seekCbs[0]!.ok();
    expect(av.calls.at(-1)).toBe('play');
    expect(events.at(-1)).toEqual(['playing', { attemptId: 8 }]);
  });

  test('a failed start seek still plays (from 0)', async () => {
    const { av, p, events } = setup();
    await p.open(URL_B, 9, { live: false, startMs: 90_000 });
    av.prepared[0]!.ok();
    av.seekCbs[0]!.fail('PLAYER_ERROR_SEEK_FAILED');
    expect(av.calls.at(-1)).toBe('play');
    expect(events.at(-1)).toEqual(['playing', { attemptId: 9 }]);
    expect(events.some(([s]) => s === 'error')).toBe(false);
  });

  test('a throwing start seek still plays', async () => {
    const { av, p, events } = setup();
    av.throwOn.add('seekTo');
    await p.open(URL_B, 1, { live: false, startMs: 5_000 });
    av.prepared[0]!.ok();
    expect(av.calls.at(-1)).toBe('play');
    expect(events.at(-1)?.[0]).toBe('playing');
  });

  test('the start seek of a stopped session does not play', async () => {
    const { av, p, events } = setup();
    await p.open(URL_B, 1, { live: false, startMs: 5_000 });
    av.prepared[0]!.ok();
    p.stop();
    av.calls = [];
    av.seekCbs[0]!.ok();
    expect(av.calls).not.toContain('play');
    expect(events.map((e) => e[0])).toEqual(['loading']);
  });

  test('VOD without a start position, and live opens, play at once without seeking', async () => {
    const vod = setup();
    await vod.p.open(URL_B, 1, { live: false, startMs: 0 });
    vod.av.prepared[0]!.ok();
    expect(vod.av.seeks).toEqual([]);
    expect(vod.av.calls.at(-1)).toBe('play');

    const live = setup();
    await live.p.open(URL_A, 2, { live: true, startMs: 5_000 });
    live.av.prepared[0]!.ok();
    expect(live.av.seeks).toEqual([]);
    expect(live.events.at(-1)).toEqual(['playing', { attemptId: 2 }]);
  });

  test('pause, play and paused map to AVPlay', async () => {
    const { av, p } = setup();
    expect(p.paused()).toBe(false);
    p.pause(); // no stream: nothing
    expect(av.calls).toEqual([]);
    await p.open(URL_B, 1, { live: false });
    av.prepared[0]!.ok();
    av.calls = [];
    p.pause();
    av.state = 'PAUSED';
    expect(p.paused()).toBe(true);
    p.play();
    av.state = 'PLAYING';
    expect(p.paused()).toBe(false);
    expect(av.calls.filter((c) => c === 'pause' || c === 'play')).toEqual(['pause', 'play']);
    av.throwOn.add('pause');
    av.throwOn.add('getState');
    expect(() => p.pause()).not.toThrow();
    expect(p.paused()).toBe(false);
  });

  test('seek clamps to [0, duration - 1 s] and is false while the duration is unknown', async () => {
    const { av, p } = setup();
    expect(p.seek(1_000)).toBe(false); // no stream
    await p.open(URL_B, 1, { live: false });
    av.prepared[0]!.ok();
    expect(p.seek(1_000)).toBe(false); // duration 0: unknown
    av.durationMs = 100_000;
    expect(p.seek(200_000)).toBe(true);
    expect(p.seek(-5_000)).toBe(true);
    expect(p.seek(42_000)).toBe(true);
    expect(av.seeks).toEqual([99_000, 0, 42_000]);
    av.throwOn.add('seekTo');
    expect(p.seek(1_000)).toBe(false);
    Object.assign(av, { seekTo: undefined });
    expect(p.seek(1_000)).toBe(false);
  });

  test('duration is getDuration (ms) when positive', async () => {
    const { av, p } = setup();
    expect(p.duration()).toBeUndefined();
    await p.open(URL_B, 1, { live: false });
    expect(p.duration()).toBeUndefined();
    av.durationMs = 3_600_000;
    expect(p.duration()).toBe(3_600_000);
    av.throwOn.add('getDuration');
    expect(p.duration()).toBeUndefined();
  });

  test('text tracks: listed from TEXT entries, selected with setSelectTrack, turned off silently', async () => {
    const { av, p } = setup();
    av.tracks = [
      { index: 0, type: 'VIDEO', extra_info: '{}' },
      { index: 1, type: 'AUDIO', extra_info: '{"language":"eng"}' },
      { index: 2, type: 'TEXT', extra_info: '{"language":"swe"}' },
      { index: 3, type: 'TEXT', extra_info: 'not json' },
    ];
    av.current = [{ index: 3, type: 'TEXT', extra_info: '' }];
    expect(p.textTracks()).toEqual([]); // no stream
    await p.open(URL_B, 1, { live: false });
    av.prepared[0]!.ok();
    expect(p.textTracks()).toEqual([
      { id: '2', label: 'swe', language: 'swe', active: false },
      { id: '3', label: 'Subtitles 2', active: true },
    ]);
    p.selectTextTrack('2');
    expect(av.selected).toEqual([['TEXT', 2]]);
    expect(av.silent).toEqual([false]);
    p.selectTextTrack('1'); // an audio track: ignored
    p.selectTextTrack('x');
    expect(av.selected).toEqual([['TEXT', 2]]);
    p.selectTextTrack(null);
    expect(av.silent).toEqual([false, true]);
    expect(p.textTracks().every((t) => !t.active)).toBe(true);
    av.throwOn.add('getTotalTrackInfo');
    expect(p.textTracks()).toEqual([]);
  });

  test('a VOD session reports isLive false once started and ends in idle, whatever IS_LIVE says', async () => {
    const { av, p, events } = setup();
    await p.open(URL_B, 4, { live: false });
    av.throwOn.add('getStreamingProperty');
    av.prepared[0]!.ok();
    expect(p.health()).toEqual({ engine: 'avplay', positionMs: 0, isLive: false });
    av.listener!.onstreamcompleted?.();
    expect(events.at(-1)).toEqual(['idle', { attemptId: 4 }]);
    expect(events.some(([s]) => s === 'error')).toBe(false);
  });

  test('duration is undefined for a live session', async () => {
    const { av, p } = setup();
    await p.open(URL_A);
    av.prepared[0]!.ok();
    av.live = { IS_LIVE: '1' };
    av.durationMs = 60_000;
    expect(p.duration()).toBeUndefined();
  });

  test('a start seek that never calls back starts playback after the seek watchdog', async () => {
    vi.useFakeTimers();
    try {
      const { av, p, events } = setup();
      await p.open(URL_B, 3, { live: false, startMs: 90_000 });
      av.prepared[0]!.ok();
      vi.advanceTimersByTime(2_900);
      expect(av.calls).not.toContain('play');
      vi.advanceTimersByTime(200);
      expect(av.calls.filter((c) => c === 'play')).toHaveLength(1);
      expect(events.at(-1)).toEqual(['playing', { attemptId: 3 }]);
      av.seekCbs[0]!.ok(); // a late callback does not start twice
      expect(av.calls.filter((c) => c === 'play')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the seek watchdog is cleared by stop and by the seek callback', async () => {
    vi.useFakeTimers();
    try {
      const a = setup();
      await a.p.open(URL_B, 1, { live: false, startMs: 5_000 });
      a.av.prepared[0]!.ok();
      a.p.stop();
      vi.advanceTimersByTime(10_000);
      expect(a.av.calls).not.toContain('play');
      const b = setup();
      await b.p.open(URL_B, 1, { live: false, startMs: 5_000 });
      b.av.prepared[0]!.ok();
      b.av.seekCbs[0]!.ok();
      vi.advanceTimersByTime(10_000);
      expect(b.av.calls.filter((c) => c === 'play')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('play() during the pending start seek is ignored', async () => {
    const { av, p } = setup();
    await p.open(URL_B, 1, { live: false, startMs: 5_000 });
    av.prepared[0]!.ok();
    p.play();
    expect(av.calls).not.toContain('play');
    av.seekCbs[0]!.ok();
    expect(av.calls.filter((c) => c === 'play')).toHaveLength(1);
  });

  test('subtitle cues: emitted for the current session, cleared on select, Off, seek, stop and a new open', async () => {
    const { av, p } = setup();
    av.tracks = [{ index: 2, type: 'TEXT', extra_info: '{}' }];
    const cues: (string | null)[] = [];
    const off = p.onSubtitle((t) => cues.push(t));
    await p.open(URL_B, 1, { live: false });
    av.prepared[0]!.ok();
    const first = av.listener!;
    first.onsubtitlechange?.(2000, 'Hello', 0, 0);
    p.selectTextTrack('2');
    first.onsubtitlechange?.(2000, 'World', 0, 0);
    av.durationMs = 100_000;
    p.seek(5_000);
    first.onsubtitlechange?.(2000, 'Again', 0, 0);
    p.selectTextTrack(null);
    first.onsubtitlechange?.(2000, 'Hidden', 0, 0); // Off: no cue
    expect(cues).toEqual(['Hello', null, 'World', null, 'Again', null]);
    cues.length = 0;
    await p.open(URL_B, 2, { live: false });
    expect(cues).toEqual([null]);
    first.onsubtitlechange?.(2000, 'stale', 0, 0); // old session
    expect(cues).toEqual([null]);
    p.stop();
    expect(cues).toEqual([null, null]);
    off();
    await p.open(URL_B, 3, { live: false });
    av.listener!.onsubtitlechange?.(2000, 'x', 0, 0);
    expect(cues).toEqual([null, null]);
  });

  test('a subtitle cue expires after its duration; a new cue, seek, select, stop or open cancels the expiry', async () => {
    vi.useFakeTimers();
    try {
      const { av, p } = setup();
      av.tracks = [{ index: 2, type: 'TEXT', extra_info: '{}' }];
      av.durationMs = 100_000;
      const cues: (string | null)[] = [];
      p.onSubtitle((t) => cues.push(t));
      await p.open(URL_B, 1, { live: false });
      av.prepared[0]!.ok();
      const l = av.listener!;
      l.onsubtitlechange?.(2000, 'Hello', 0, 0);
      vi.advanceTimersByTime(1999);
      expect(cues).toEqual(['Hello']);
      vi.advanceTimersByTime(1);
      expect(cues).toEqual(['Hello', null]);

      // A new cue replaces the old one and its expiry.
      cues.length = 0;
      l.onsubtitlechange?.(2000, 'One', 0, 0);
      vi.advanceTimersByTime(1000);
      l.onsubtitlechange?.(3000, 'Two', 0, 0);
      vi.advanceTimersByTime(2999);
      expect(cues).toEqual(['One', 'Two']);
      vi.advanceTimersByTime(1);
      expect(cues).toEqual(['One', 'Two', null]);

      // Seek, select, Off and stop clear at once; no late expiry follows.
      for (const clear of [() => p.seek(5_000), () => p.selectTextTrack('2'), () => p.selectTextTrack(null)]) {
        p.selectTextTrack('2'); // subtitles on again for the next cue
        cues.length = 0;
        l.onsubtitlechange?.(2000, 'Cue', 0, 0);
        clear();
        vi.advanceTimersByTime(5000);
        expect(cues).toEqual(['Cue', null]);
      }
      p.selectTextTrack('2');
      cues.length = 0;
      l.onsubtitlechange?.(2000, 'Last', 0, 0);
      p.stop();
      vi.advanceTimersByTime(5000);
      expect(cues).toEqual(['Last', null]);

      // A new open also cancels the expiry of the previous session's cue.
      await p.open(URL_B, 2, { live: false });
      av.prepared[1]!.ok();
      av.listener!.onsubtitlechange?.(2000, 'New', 0, 0);
      cues.length = 0;
      await p.open(URL_B, 3, { live: false });
      vi.advanceTimersByTime(5000);
      expect(cues).toEqual([null]);

      // No usable duration: the cue stays until the next one.
      av.prepared[2]!.ok();
      cues.length = 0;
      av.listener!.onsubtitlechange?.('?', 'Stays', 0, 0);
      vi.advanceTimersByTime(60_000);
      expect(cues).toEqual(['Stays']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Off drops cues and shows no active track even when the firmware lacks setSilentSubtitle', async () => {
    const { av, p } = setup();
    av.tracks = [{ index: 2, type: 'TEXT', extra_info: '{}' }];
    av.current = [{ index: 2, type: 'TEXT', extra_info: '' }];
    Object.assign(av, { setSilentSubtitle: undefined });
    const cues: (string | null)[] = [];
    p.onSubtitle((t) => cues.push(t));
    await p.open(URL_B, 1, { live: false });
    av.prepared[0]!.ok();
    p.selectTextTrack(null);
    cues.length = 0;
    av.listener!.onsubtitlechange?.(2000, 'Hidden', 0, 0);
    expect(cues).toEqual([]);
    expect(p.textTracks()[0]!.active).toBe(false);
    p.selectTextTrack('2'); // a track again: cues show
    av.listener!.onsubtitlechange?.(2000, 'Shown', 0, 0);
    expect(cues).toContain('Shown');
  });
});

describe('AvplayPlayer: User-Agent, close before open, status awareness', () => {
  test('headers.userAgent is set as USER_AGENT after open() and before prepareAsync', async () => {
    const { av, p } = setup();
    await p.open(URL_A, 1, { headers: { userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.test/' } });
    expect(av.props).toContainEqual(['USER_AGENT', 'SyntheticAgent/1.0']);
    expect(av.props.at(-1)).toEqual(['USER_AGENT', 'SyntheticAgent/1.0']);
    const uaCall = av.calls.lastIndexOf('setStreamingProperty');
    expect(av.calls.indexOf('open')).toBeLessThan(uaCall);
    expect(uaCall).toBeLessThan(av.calls.indexOf('prepareAsync'));
    // The referrer has no AVPlay property: nothing else is set from the headers.
    expect(av.props.filter(([t]) => t !== 'ADAPTIVE_INFO')).toEqual([['USER_AGENT', 'SyntheticAgent/1.0']]);
  });

  test('no User-Agent without headers (or with an empty one)', async () => {
    const { av, p } = setup();
    await p.open(URL_A, 1);
    await p.open(URL_A, 2, { headers: { userAgent: '' } });
    expect(av.props.some(([t]) => t === 'USER_AGENT')).toBe(false);
  });

  test('a throwing USER_AGENT call is ignored: the stream still prepares', async () => {
    const av = new FakeAvplay();
    const p = new AvplayPlayer(av);
    const orig = av.setStreamingProperty.bind(av);
    av.setStreamingProperty = (t: string, v: string) => {
      if (t === 'USER_AGENT') throw Object.assign(new Error('boom'), { name: 'InvalidValuesError' });
      orig(t, v);
    };
    await p.open(URL_A, 1, { headers: { userAgent: 'SyntheticAgent/1.0' } });
    expect(av.calls).toContain('prepareAsync');
  });

  test('closed() resolves after close(); AVPlay never reports statuses', async () => {
    const { av, p } = setup();
    await p.open(URL_A, 1);
    p.stop();
    await p.closed();
    expect(av.calls).toContain('close');
    expect((p as Player).supportsStatus?.() ?? false).toBe(false);
  });
});

describe('AvplayPlayer: suspend / resume', () => {
  async function vodPlaying() {
    const s = setup();
    await s.p.open(URL_A, 1, { live: false });
    s.av.prepared[0]!.ok();
    s.av.time = 90_000;
    return s;
  }
  test('VOD: suspend() calls avplay.suspend; resume() restores at the position without prepare', async () => {
    const { av, p } = await vodPlaying();
    p.suspend!();
    expect(av.calls).toContain('suspend');
    expect(p.resume!()).toBe(true);
    expect(av.restores).toEqual([[URL_A, 90_000, false]]);
  });
  test('resume() is false when restore throws (caller reopens)', async () => {
    const { av, p } = await vodPlaying();
    p.suspend!();
    av.throwOn.add('restore');
    expect(p.resume!()).toBe(false);
  });
  test('live sessions are not suspended, and resume() without suspend is false', async () => {
    const { av, p } = setup();
    await p.open(URL_A, 1);
    av.prepared[0]!.ok();
    p.suspend!();
    expect(av.calls).not.toContain('suspend');
    expect(p.resume!()).toBe(false);
  });
  test('resume() keeps a paused session paused and arms no watchdog', async () => {
    vi.useFakeTimers();
    const { av, p, events } = await vodPlaying();
    av.state = 'PAUSED';
    p.suspend!();
    av.calls = [];
    expect(p.resume!()).toBe(true);
    expect(av.calls).toContain('pause');
    vi.advanceTimersByTime(6_000);
    expect(events.some(([s]) => s === 'error')).toBe(false);
    vi.useRealTimers();
  });
  test('restore watchdog: no play time within 5 s → error NETWORK restoreTimeout', async () => {
    vi.useFakeTimers();
    const { p, events } = await vodPlaying();
    p.suspend!();
    p.resume!();
    vi.advanceTimersByTime(5_001);
    expect(events.at(-1)?.[0]).toBe('error');
    expect(events.at(-1)?.[1]?.detail).toBe('restoreTimeout');
    vi.useRealTimers();
  });
  test('restore watchdog: polled position moving past the saved one counts as success (no oncurrentplaytime)', async () => {
    vi.useFakeTimers();
    const { av, p, events } = await vodPlaying();
    p.suspend!();
    p.resume!();
    av.time = 92_000;
    vi.advanceTimersByTime(6_000);
    expect(events.some(([s]) => s === 'error')).toBe(false);
    vi.useRealTimers();
  });
  test('restore watchdog: state PLAYING counts as success', async () => {
    vi.useFakeTimers();
    const { av, p, events } = await vodPlaying();
    p.suspend!();
    p.resume!();
    av.state = 'PLAYING';
    vi.advanceTimersByTime(6_000);
    expect(events.some(([s]) => s === 'error')).toBe(false);
    vi.useRealTimers();
  });
  test('restore watchdog: a throwing getState with a stuck position still errors', async () => {
    vi.useFakeTimers();
    const { av, p, events } = await vodPlaying();
    p.suspend!();
    p.resume!();
    av.throwOn.add('getState');
    vi.advanceTimersByTime(5_001);
    expect(events.at(-1)?.[1]?.detail).toBe('restoreTimeout');
    vi.useRealTimers();
  });
  test('suspend() releases a held frame and clears a pending prepare watchdog', async () => {
    vi.useFakeTimers();
    const { av, p, events } = setup();
    await p.open(URL_A, 1, { live: false });
    p.holdLastFrame!();
    p.suspend!();
    expect(av.still.at(-1)).toBe('false');
    vi.advanceTimersByTime(120_000);
    expect(events.some(([, d]) => d?.detail === 'prepareTimeout')).toBe(false);
    vi.useRealTimers();
  });
  test('oncurrentplaytime clears the restore watchdog', async () => {
    vi.useFakeTimers();
    const { av, p, events } = await vodPlaying();
    p.suspend!();
    p.resume!();
    av.listener!.oncurrentplaytime!(91_000);
    vi.advanceTimersByTime(6_000);
    expect(events.some(([s, d]) => s === 'error' && d?.detail === 'restoreTimeout')).toBe(false);
    vi.useRealTimers();
  });
});

describe('AvplayPlayer: screensaver', () => {
  function withSaver() {
    const av = new FakeAvplay();
    const saver: string[] = [];
    const p = new AvplayPlayer(av, { screenSaver: (s) => saver.push(s) });
    return { av, p, saver };
  }
  test('fullscreen playing → off; pause → on; play → off; stop → on', async () => {
    const { av, p, saver } = withSaver();
    p.setRect('fullscreen');
    await p.open(URL_A, 1, { live: false });
    av.prepared[0]!.ok();
    expect(saver.at(-1)).toBe('off');
    p.pause!();
    expect(saver.at(-1)).toBe('on');
    p.play!();
    expect(saver.at(-1)).toBe('off');
    p.stop();
    expect(saver.at(-1)).toBe('on');
  });
  test('preview rect never turns it off', async () => {
    const { av, p, saver } = withSaver();
    p.setRect({ x: 100, y: 100, w: 640, h: 360 });
    await p.open(URL_A, 1);
    av.prepared[0]!.ok();
    expect(saver).not.toContain('off');
  });
  test('error → on, but a held last frame keeps it off until the reopen', async () => {
    const { av, p, saver } = withSaver();
    p.setRect('fullscreen');
    await p.open(URL_A, 1);
    av.prepared[0]!.ok();
    p.holdLastFrame!();
    av.listener!.onerror!('PLAYER_ERROR_CONNECTION_FAILED');
    expect(saver.at(-1)).toBe('off');
    p.releaseLastFrame!();
    expect(saver.at(-1)).toBe('on');
  });
  test('a hold outliving stop is capped: saver returns to on after 30 s', async () => {
    vi.useFakeTimers();
    try {
      const { av, p, saver } = withSaver();
      p.setRect('fullscreen');
      await p.open(URL_A, 1);
      av.prepared[0]!.ok();
      p.holdLastFrame!();
      p.stop();
      expect(saver.at(-1)).toBe('off');
      vi.advanceTimersByTime(30_000);
      expect(saver.at(-1)).toBe('on');
      expect(av.still.at(-1)).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });
  test('a second hold does not extend the 30 s cap', async () => {
    vi.useFakeTimers();
    try {
      const { av, p } = withSaver();
      p.setRect('fullscreen');
      await p.open(URL_A, 1);
      av.prepared[0]!.ok();
      p.holdLastFrame!();
      vi.advanceTimersByTime(20_000);
      p.holdLastFrame!();
      vi.advanceTimersByTime(10_001);
      expect(av.still.at(-1)).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });
  test('a hold released early never fires the cap', async () => {
    vi.useFakeTimers();
    try {
      const { av, p } = withSaver();
      p.setRect('fullscreen');
      await p.open(URL_A, 1);
      av.prepared[0]!.ok();
      p.holdLastFrame!();
      p.releaseLastFrame!();
      const n = av.still.length;
      vi.advanceTimersByTime(60_000);
      expect(av.still.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
  test('suspend → on', async () => {
    const { av, p, saver } = withSaver();
    p.setRect('fullscreen');
    await p.open(URL_A, 1, { live: false });
    av.prepared[0]!.ok();
    p.suspend!();
    expect(saver.at(-1)).toBe('on');
  });
});

describe('AvplayPlayer: audio track facts', () => {
  async function withTracks(tracks: AvplayTrack[], activeIndex: number) {
    const s = setup();
    s.av.tracks = tracks;
    s.av.current = tracks.filter((t) => t.index === activeIndex || t.type === 'VIDEO');
    await s.p.open(URL_A, 1, { live: false });
    s.av.prepared[0]!.ok();
    return s;
  }
  const vid: AvplayTrack = { index: 0, type: 'VIDEO', extra_info: '{"fourCC":"H264","Width":"1920","Height":"1080"}' };
  const dts: AvplayTrack = { index: 1, type: 'AUDIO', extra_info: '{"fourCC":"DTS","language":"eng","channels":"6"}' };
  const aac: AvplayTrack = { index: 2, type: 'AUDIO', extra_info: '{"fourCC":"AAC","language":"eng","channels":"2"}' };

  test('audioTracks carries codec, channels and supported', async () => {
    const { p } = await withTracks([vid, dts, aac], 1);
    expect(p.audioTracks()).toEqual([
      expect.objectContaining({ id: '1', codec: 'dts', channels: 6, supported: 'no', active: true }),
      expect.objectContaining({ id: '2', codec: 'aac', channels: 2, active: false }),
    ]);
    expect(p.audioTracks()[1]!.supported).not.toBe('no');
  });
  test('soundUndecodable: true when every audio track is none in the Tizen caps', async () => {
    expect((await withTracks([vid, dts], 1)).p.soundUndecodable()).toBe(true);
  });
  test('soundUndecodable: false while a decodable or unknown track exists', async () => {
    expect((await withTracks([vid, dts, aac], 1)).p.soundUndecodable()).toBe(false);
    const odd: AvplayTrack = { index: 3, type: 'AUDIO', extra_info: '{"fourCC":"ZZZ"}' };
    expect((await withTracks([vid, odd], 3)).p.soundUndecodable()).toBe(false);
  });
  test('soundUndecodable: true when the picture plays and AVPlay lists no audio at all', async () => {
    expect((await withTracks([vid], 0)).p.soundUndecodable()).toBe(true);
  });
  test('soundUndecodable: false before the stream has started', async () => {
    const s = setup();
    s.av.tracks = [vid, dts];
    await s.p.open(URL_A, 1, { live: false });
    expect(s.p.soundUndecodable()).toBe(false);
  });
  test('soundUndecodable: false when nothing is open', () => {
    expect(setup().p.soundUndecodable()).toBe(false);
  });

  // Spellings named by tizen.md section 4.1 and the codec golden vectors. UNVERIFIED against real firmware.
  test.each([
    ['DTS', 'dts'], ['DCA', 'dts'], ['dtsc', 'dts'], ['dtse', 'dtshd'], ['dtsh', 'dtshd'],
    ['TRUEHD', 'truehd'], ['MLP', 'truehd'], ['AC3', 'ac3'], ['EAC3', 'eac3'],
    ['AAC', 'aac'], ['MP3', 'mp3'], ['MPEG', 'mp2'], ['OPUS', 'opus'], ['AC-4', 'ac4'], ['LPCM', 'pcm'],
  ])('fourCC %s gets codec %s', async (fourCC, codec) => {
    const t: AvplayTrack = { index: 1, type: 'AUDIO', extra_info: JSON.stringify({ fourCC }) };
    const { p } = await withTracks([vid, t], 1);
    expect(p.audioTracks()[0]!.codec).toBe(codec);
  });
});

describe('AvplayPlayer: panel caps', () => {
  test('UHD panel: ADAPTIVE_INFO carries FIXED_MAX_RESOLUTION in one call', async () => {
    const av = new FakeAvplay();
    const p = new AvplayPlayer(av, { panel: { uhd: true, eightK: false, hdrTv: true } });
    await p.open(URL_B, 1);
    expect(av.props.filter(([k]) => k === 'ADAPTIVE_INFO')).toEqual([['ADAPTIVE_INFO', 'STARTBITRATE=LOWEST|FIXED_MAX_RESOLUTION=3840X2160']]);
  });
  test("no panel info: today's STARTBITRATE=LOWEST", async () => {
    const { av, p } = setup();
    await p.open(URL_B, 1);
    expect(av.props).toContainEqual(['ADAPTIVE_INFO', 'STARTBITRATE=LOWEST']);
  });
  test('capsProbe: max height and HDR from the panel', () => {
    const p = new AvplayPlayer(new FakeAvplay(), { panel: { uhd: true, eightK: false, hdrTv: true, answered: { uhd: true, eightK: true, hdrTv: true } } });
    expect(p.capsProbe()).toEqual({
      display: {
        maxHeight: { value: 2160, evidence: 'probe' },
        hdr: {
          hdr10: { value: 'decode', evidence: 'probe' },
          hdr10plus: { value: 'decode', evidence: 'probe' },
          hlg: { value: 'decode', evidence: 'probe' },
        },
      },
    });
    expect(new AvplayPlayer(new FakeAvplay()).capsProbe()).toEqual({});
  });
  test('no API answered (monitor, throwing or missing APIs): capsProbe is empty, ADAPTIVE_INFO unchanged', async () => {
    const av = new FakeAvplay();
    const p = new AvplayPlayer(av, { panel: { uhd: false, eightK: false, hdrTv: false } });
    expect(p.capsProbe()).toEqual({});
    await p.open(URL_B, 1);
    expect(av.props.filter(([k]) => k === 'ADAPTIVE_INFO')).toEqual([['ADAPTIVE_INFO', 'STARTBITRATE=LOWEST']]);
  });
  test('answered-false panel still reports 1080p and no HDR', async () => {
    const av = new FakeAvplay();
    const p = new AvplayPlayer(av, { panel: { uhd: false, eightK: false, hdrTv: false, answered: { uhd: true, eightK: true, hdrTv: true } } });
    expect(p.capsProbe()).toEqual({
      display: {
        maxHeight: { value: 1080, evidence: 'probe' },
        hdr: {
          hdr10: { value: 'none', evidence: 'probe' },
          hdr10plus: { value: 'none', evidence: 'probe' },
          hlg: { value: 'none', evidence: 'probe' },
        },
      },
    });
    await p.open(URL_B, 1);
    expect(av.props.filter(([k]) => k === 'ADAPTIVE_INFO')).toEqual([['ADAPTIVE_INFO', 'STARTBITRATE=LOWEST']]);
  });
  test('partial answers: only answered facts are reported', () => {
    const hdrOnly = new AvplayPlayer(new FakeAvplay(), { panel: { uhd: false, eightK: false, hdrTv: true, answered: { hdrTv: true } } });
    expect(Object.keys(hdrOnly.capsProbe().display ?? {})).toEqual(['hdr']);
    const uhdOnly = new AvplayPlayer(new FakeAvplay(), { panel: { uhd: true, eightK: false, hdrTv: false, answered: { uhd: true } } });
    expect(uhdOnly.capsProbe()).toEqual({ display: { maxHeight: { value: 2160, evidence: 'probe' } } });
  });
  test('panelCaps returns a copy, undefined without panel facts', () => {
    const panel = { uhd: true, eightK: false, hdrTv: false };
    const p = new AvplayPlayer(new FakeAvplay(), { panel });
    expect(p.panelCaps()).toEqual(panel);
    expect(p.panelCaps()).not.toBe(panel);
    expect(new AvplayPlayer(new FakeAvplay()).panelCaps()).toBeUndefined();
  });
});
