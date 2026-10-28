import type { EngineName } from '../types.ts';
import type { AudioCodec, Cap, CapsPlatform, MediaCaps, Support } from './types.ts';

const s = <T>(value: T): Cap<T> => ({ value, evidence: 'static' });
const ALL_AUDIO: AudioCodec[] = ['aac', 'mp2', 'mp3', 'ac3', 'eac3', 'eac3joc', 'truehd', 'dts', 'dtshd', 'opus', 'flac', 'ac4', 'pcm'];
function audio(decode: AudioCodec[], none: AudioCodec[]): MediaCaps['audio'] {
  const out: MediaCaps['audio'] = {};
  for (const a of decode) out[a] = s<Support>('decode');
  for (const a of none) out[a] = s<Support>('none');
  return out;
}
const CHROMIUM_NONE: AudioCodec[] = ['ac3', 'eac3', 'eac3joc', 'truehd', 'dts', 'dtshd', 'ac4'];
const MPEGTS_QUIRKS = { firstAudioPidOnly: true, dvbAc3Undetected: true, noMpeg2: true };

/** What the research documents per platform and engine; everything else is unknown. Spec §4.2. */
export function staticCaps(platform: CapsPlatform, engine: EngineName): MediaCaps {
  const caps: MediaCaps = {
    schema: 1, platform, engine, device: {},
    display: { maxHeight: s(1080), hdr: {}, refreshSwitch: s(platform === 'tizen' || platform === 'webos' ? 'tv-panel' : 'none') },
    video: {}, audio: {}, audioSink: { value: { maxPcmChannels: 2, route: 'unknown', atmos: false }, evidence: 'static' },
    containers: {}, subs: {}, quirks: engine === 'mpegts.js' ? { ...MPEGTS_QUIRKS } : {},
  };
  if (engine === 'mpv') {
    caps.audio = audio(ALL_AUDIO, []);
    return caps;
  }
  if (engine === 'media3') return caps;
  if (platform === 'browser' || platform === 'desktop') {
    caps.audio = audio(['aac', 'mp3', 'opus', 'flac'], CHROMIUM_NONE);
    caps.video.mpeg2 = s<Support>('none');
  } else if (platform === 'tizen') {
    caps.audio = audio(['aac', 'mp2', 'mp3', 'ac3', 'eac3'], ['truehd', 'dts', 'dtshd']);
    caps.display.hdr.dv5 = s<Support>('none');
    caps.display.hdr.dv8 = s<Support>('none');
  } else if (platform === 'webos') {
    caps.audio = audio(['aac', 'mp3', 'ac3', 'eac3'], ['truehd']);
  }
  return caps;
}
