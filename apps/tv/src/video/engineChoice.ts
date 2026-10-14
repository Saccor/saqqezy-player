/** What the `<video>` element and the bundled MSE engines can do on this device. */
export interface EngineCaps {
  /** `canPlayType('application/vnd.apple.mpegurl') !== ''` */
  nativeHls: boolean;
  /** `canPlayType('video/mp2t') !== ''` */
  nativeTs: boolean;
  /** `Hls.isSupported()` */
  hlsJs: boolean;
  /** `mpegts.isSupported()` */
  mpegtsJs: boolean;
  preferNativeHls: boolean;
}

export type EngineChoice =
  | { engine: 'native'; fallback?: 'mpegts' }
  | { engine: 'hls' }
  | { engine: 'mpegts' }
  | { engine: 'none'; reason: 'hls' | 'mpegts' };

/**
 * Picks the playback engine from the URL path (lower-cased, no query). `.m3u8`: native HLS or hls.js; `.ts`:
 * mpegts.js; another extension: the element. No extension (e.g. the Xtream short form `/{user}/{pass}/{id}`,
 * MPEG-TS by default): the element only when it says it plays MPEG-TS, with mpegts.js as the fallback if the
 * load fails before metadata; otherwise mpegts.js.
 */
export function chooseEngine(path: string, caps: EngineCaps): EngineChoice {
  if (path.endsWith('.m3u8')) {
    if (caps.preferNativeHls && caps.nativeHls) return { engine: 'native' };
    return caps.hlsJs ? { engine: 'hls' } : { engine: 'none', reason: 'hls' };
  }
  if (path.endsWith('.ts')) return caps.mpegtsJs ? { engine: 'mpegts' } : { engine: 'none', reason: 'mpegts' };
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last.includes('.')) return { engine: 'native' };
  if (caps.nativeTs) return caps.mpegtsJs ? { engine: 'native', fallback: 'mpegts' } : { engine: 'native' };
  return caps.mpegtsJs ? { engine: 'mpegts' } : { engine: 'native' };
}
