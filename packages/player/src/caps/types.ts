import type { EngineName } from '../types.ts';

/** Same union as the app's PlatformId, declared again so that @iptv/player keeps no package dependencies. */
export type CapsPlatform = 'browser' | 'desktop' | 'tizen' | 'webos' | 'androidtv';
export type VideoCodec = 'h264' | 'hevc' | 'hevc10' | 'av1' | 'vp9' | 'mpeg2' | 'vc1';
export type HdrFormat = 'hdr10' | 'hdr10plus' | 'hlg' | 'dv5' | 'dv7' | 'dv8';
export type AudioCodec = 'aac' | 'mp2' | 'mp3' | 'ac3' | 'eac3' | 'eac3joc' | 'truehd' | 'dts' | 'dtshd' | 'opus' | 'flac' | 'ac4' | 'pcm';
export type SubFormat = 'webvtt' | 'srt' | 'ass' | 'pgs' | 'dvbsub' | 'teletext' | 'cea608' | 'cea708' | 'ttml' | 'sami';
export type Container = 'ts' | 'hls-ts' | 'hls-fmp4' | 'dash' | 'mkv' | 'mp4' | 'webm' | 'avi';

/** decode = we/the device turn it into PCM/pixels; passthrough = bitstream to the sink; app = our renderer draws it. */
export type Support = 'decode' | 'passthrough' | 'both' | 'none' | 'unknown';
export type Evidence = 'static' | 'probe' | 'learned';

export interface Cap<T = Support> { value: T; evidence: Evidence }

export interface MediaCaps {
  schema: 1;
  platform: CapsPlatform;
  /** Caps are per engine: webOS native differs from webOS MSE. */
  engine: EngineName;
  device: { model?: string; firmware?: string; year?: number };
  display: {
    /** 1080 / 2160 / 4320. */
    maxHeight: Cap<number>;
    /** 'decode' = the display shows it; 'none' = it will tone map or mis-colour. */
    hdr: Partial<Record<HdrFormat, Cap>>;
    /** Who handles 24/25/50 Hz: the TV panel (Tizen/webOS), the app (Android/PC), or nobody. */
    refreshSwitch: Cap<'tv-panel' | 'app' | 'none'>;
  };
  video: Partial<Record<VideoCodec, Cap & { maxHeight?: number; interlaced?: Support }>>;
  audio: Partial<Record<AudioCodec, Cap>>;
  audioSink: Cap<{ maxPcmChannels: number; route: 'speakers' | 'hdmi' | 'arc' | 'bluetooth' | 'unknown'; atmos: boolean }>;
  containers: Partial<Record<Container, Cap>>;
  subs: Partial<Record<SubFormat, Cap<'native' | 'app' | 'none' | 'unknown'>>>;
  /** Engine quirks the decision functions need (e.g. mpegts.js: first audio PID only, no DVB AC-3). */
  quirks: { firstAudioPidOnly?: boolean; dvbAc3Undetected?: boolean; noMpeg2?: boolean; textSubsViaCallback?: boolean };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
/** What a native host reports in `hello`; `evidence: 'probe'` is implied. */
export type MediaCapsProbe = DeepPartial<Omit<MediaCaps, 'schema' | 'platform' | 'engine'>>;
