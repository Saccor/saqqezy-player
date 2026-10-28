import type { AudioCodec } from './types.ts';

const AUDIO: Record<string, AudioCodec> = {
  'aac': 'aac', 'audio/mp4a-latm': 'aac', 'ac-3': 'ac3', 'ac3': 'ac3', 'audio/ac3': 'ac3', 'a_ac3': 'ac3',
  'ec-3': 'eac3', 'eac3': 'eac3', 'audio/eac3': 'eac3', 'a_eac3': 'eac3', 'audio/eac3-joc': 'eac3joc', 'ec+3': 'eac3joc',
  'mlpa': 'truehd', 'truehd': 'truehd', 'mlp': 'truehd', 'audio/true-hd': 'truehd', 'a_truehd': 'truehd',
  'dtsc': 'dts', 'dts': 'dts', 'dca': 'dts', 'audio/vnd.dts': 'dts', 'a_dts': 'dts',
  'dtse': 'dtshd', 'dtsh': 'dtshd', 'dtsl': 'dtshd', 'dtsx': 'dtshd', 'audio/vnd.dts.hd': 'dtshd',
  'mp2': 'mp2', 'mpeg': 'mp2', 'mp4a.40.34': 'mp2', 'mp3': 'mp3', 'mp4a.6b': 'mp3', 'mp4a.69': 'mp3',
  'opus': 'opus', 'flac': 'flac', 'ac-4': 'ac4', 'lpcm': 'pcm',
};

/** Normalises a codec name from any engine (RFC 6381, MIME, AVPlay fourCC, FFmpeg, Matroska). Spec §4.1. */
export function audioCodecOf(raw: string | undefined): AudioCodec | undefined {
  if (!raw) return undefined;
  const k = raw.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(AUDIO, k)) return AUDIO[k];
  if (/^mp4a\.40\.\d+$/.test(k) && k !== 'mp4a.40.34') return 'aac';
  if (k.indexOf('pcm_') === 0) return 'pcm';
  return undefined;
}
