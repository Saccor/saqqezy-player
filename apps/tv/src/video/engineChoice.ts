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
    if (caps.hlsJs) return { engine: 'hls' };
    return caps.nativeHls ? { engine: 'native' } : { engine: 'none', reason: 'hls' };
  }
  if (path.endsWith('.ts')) return caps.mpegtsJs ? { engine: 'mpegts' } : { engine: 'none', reason: 'mpegts' };
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last.includes('.')) return { engine: 'native' };
  if (caps.nativeTs) return caps.mpegtsJs ? { engine: 'native', fallback: 'mpegts' } : { engine: 'native' };
  return caps.mpegtsJs ? { engine: 'mpegts' } : { engine: 'native' };
}

export type TriedEngine = 'native' | 'hls' | 'mpegts';

/**
 * Which engine to retry the same URL with after `tried` (in order) failed. Only an extensionless URL that mpegts.js
 * rejected as not MPEG-TS/FLV (`errorKind` 'format', before metadata) is retried, once, as HLS: natively when the
 * element plays it, else hls.js. `ext` is the URL's extension ('' when it has none).
 */
export function nextEngineAfterFailure(
  ext: string,
  tried: readonly TriedEngine[],
  errorKind: 'format' | 'other',
  caps: Pick<EngineCaps, 'nativeHls' | 'hlsJs'>,
): 'native' | 'hls' | undefined {
  if (ext !== '' || errorKind !== 'format' || !tried.includes('mpegts')) return undefined;
  if (tried.includes('hls') || tried.includes('native')) return undefined;
  if (caps.nativeHls) return 'native';
  return caps.hlsJs ? 'hls' : undefined;
}
